const express = require('express');
const cors = require('cors');
const { v4: uuid } = require('uuid');
const path = require('path');
const OpenAI = require('openai');
require('dotenv').config();

const db = require('./db');
const docs = require('./documents');
const notifications = require('./notifications');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Admin token required' });
    }
    next();
}

function identifyUser(req) {
    return {
        userId: req.headers['x-user-id'] || 'anonymous',
        userName: req.headers['x-user-name'] || 'Anonymous User',
        userEmail: req.headers['x-user-email'] || null,
        department: req.headers['x-department'] || null
    };
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are the PMO (Programme Management Office) Assistant for a Vehicle Programme.

Your job:
- Answer questions about PMO processes, reporting standards, governance, and terminology
- Use ONLY information from the documents provided in the context
- Be concise, professional, and helpful
- Reference the conversation history to give context-aware answers

Rules:
- If the documents do not contain the answer, say so clearly: "I don't have information about that in the PMO documentation."
- Never invent information
- Keep responses short (1-3 short paragraphs maximum unless asked for detail)
- When mentioning processes, cite the document name if helpful
- Be conversational but professional`;

async function categoriseQuery(question) {
    const categories = [
        'Reporting and Templates', 'Process and Procedures', 'Governance and Approvals',
        'PMO Terminology', 'Resource and Planning', 'Risk and Issues',
        'Contact and Escalation', 'Other'
    ];

    try {
        const res = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{
                role: 'user',
                content: `Categorise this PMO question into ONE of: ${categories.join(', ')}.\n\nQuestion: "${question}"\n\nReply with ONLY the category name.`
            }],
            temperature: 0,
            max_tokens: 20
        });
        const cat = res.choices[0].message.content.trim();
        return categories.includes(cat) ? cat : 'Other';
    } catch {
        return 'Other';
    }
}

function calculateConfidence(answer, chunks, question) {
    let score = 0.5;

    const uncertainPhrases = [
        "i don't have information", "not in the", "couldn't find", "no information",
        "not mentioned", "unable to", "cannot find", "isn't in"
    ];
    const answerLower = answer.toLowerCase();
    for (const phrase of uncertainPhrases) {
        if (answerLower.includes(phrase)) {
            score -= 0.35;
            break;
        }
    }

    if (chunks.length >= 3) score += 0.15;
    else if (chunks.length >= 2) score += 0.1;

    if (answer.length > 200 && !uncertainPhrases.some(p => answerLower.includes(p))) {
        score += 0.15;
    }

    const terms = question.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    const chunkText = chunks.map(c => c.content.toLowerCase()).join(' ');
    const covered = terms.filter(t => chunkText.includes(t)).length;
    if (terms.length > 0) {
        score += (covered / terms.length) * 0.2;
    }

    return Math.max(0, Math.min(1, score));
}

app.post('/api/session', (req, res) => {
    const user = identifyUser(req);
    const sessionId = uuid();
    db.createSession(sessionId, user.userId, user.userName, user.department);
    res.json({ sessionId });
});

app.post('/api/ask', async (req, res) => {
    const { question, sessionId: providedSessionId } = req.body;
    const user = identifyUser(req);

    if (!question) {
        return res.status(400).json({ error: 'Question is required' });
    }

    let sessionId = providedSessionId;
    if (!sessionId || !db.getSession(sessionId)) {
        sessionId = uuid();
        db.createSession(sessionId, user.userId, user.userName, user.department);
    } else {
        db.touchSession(sessionId);
    }

    console.log(`[${user.userName}] "${question}"`);
    const startTime = Date.now();

    try {
        db.addMessage(sessionId, 'user', question);

        const history = db.getSessionHistory(sessionId, 8);
        const priorHistory = history.slice(0, -1);

        const chunks = docs.search(question, 4);
        console.log(`  Found ${chunks.length} relevant chunks`);

        const categoryPromise = categoriseQuery(question);

        let answer, confidence, sources;

        if (chunks.length === 0) {
            answer = "I couldn't find any relevant information in the PMO documentation for that question. I will raise a ticket so the PMO team can help you directly.";
            confidence = 0;
            sources = [];
        } else {
            const context = chunks
                .map((c, i) => `[Doc ${i + 1}: ${c.docName}]\n${c.content}`)
                .join('\n\n---\n\n');

            const messages = [
                { role: 'system', content: `${SYSTEM_PROMPT}\n\nDOCUMENT CONTEXT:\n${context}` }
            ];

            for (const msg of priorHistory.slice(-6)) {
                messages.push({ role: msg.role, content: msg.content });
            }

            messages.push({ role: 'user', content: question });

            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages,
                temperature: 0.2,
                max_tokens: 600
            });

            answer = completion.choices[0].message.content;
            confidence = calculateConfidence(answer, chunks, question);
            sources = [...new Set(chunks.map(c => c.docName))];
        }

        const category = await categoryPromise;
        const responseTimeMs = Date.now() - startTime;
        const interactionId = uuid();

        db.addMessage(sessionId, 'assistant', answer);

        let ticketId = null;
        const shouldEscalate = confidence < 0.25;

        if (shouldEscalate) {
            ticketId = 'PMO-' + Date.now().toString(36).toUpperCase();
            const priority = confidence < 0.1 ? 'high' : 'medium';

            db.createTicket({
                id: ticketId,
                sessionId,
                userId: user.userId,
                userName: user.userName,
                userEmail: user.userEmail,
                department: user.department,
                question,
                category,
                priority
            });

            const ticketRow = db.getTicket(ticketId);
            notifications.notifyPMOTeamOfTicket(ticketRow).catch(err =>
                console.error('PMO notification failed:', err.message)
            );
            if (user.userEmail) {
                notifications.notifyUserOfTicketCreated(ticketRow).catch(err =>
                    console.error('User notification failed:', err.message)
                );
            }

            console.log(`  Escalated to ticket ${ticketId}`);
        }

        db.logInteraction({
            id: interactionId,
            sessionId,
            userId: user.userId,
            userName: user.userName,
            department: user.department,
            question,
            answer,
            category,
            confidence,
            sources,
            responseTimeMs,
            escalated: shouldEscalate,
            ticketId
        });

        console.log(`  Confidence ${Math.round(confidence * 100)}%, ${responseTimeMs}ms, ${category}`);

        res.json({
            interactionId,
            sessionId,
            answer,
            sources,
            confidence,
            category,
            escalated: shouldEscalate,
            ticketId,
            responseTimeMs
        });

    } catch (err) {
        console.error('Error:', err.message);
        res.status(500).json({
            error: 'Something went wrong. Please try again or contact the PMO team.'
        });
    }
});

app.post('/api/rate', (req, res) => {
    const { interactionId, rating, feedback } = req.body;

    if (!interactionId || !rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'interactionId and rating (1-5) required' });
    }

    const ok = db.rateInteraction(interactionId, rating, feedback);
    if (!ok) return res.status(404).json({ error: 'Interaction not found' });

    console.log(`Rating ${rating}/5 for ${interactionId}`);
    res.json({ success: true, message: 'Thank you for your feedback.' });
});

app.get('/api/session/:id/history', (req, res) => {
    const session = db.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const messages = db.getSessionHistory(req.params.id, 50);
    res.json({ session, messages });
});

app.get('/api/documents', (req, res) => {
    res.json({ documents: docs.getAll(), total: docs.getCount() });
});

app.get('/api/tickets', (req, res) => {
    const user = identifyUser(req);
    const isAdmin = req.headers['x-admin-token'] === process.env.ADMIN_TOKEN;

    let tickets = db.getTickets(req.query.status);

    if (!isAdmin) {
        tickets = tickets.filter(t => t.userId === user.userId);
    }

    res.json({ tickets, total: tickets.length });
});

app.put('/api/tickets/:id', requireAdmin, async (req, res) => {
    const { status, resolution, assignedTo } = req.body;

    const ok = db.updateTicket(req.params.id, status, resolution, assignedTo);
    if (!ok) return res.status(404).json({ error: 'Ticket not found' });

    const ticket = db.getTicket(req.params.id);

    if (ticket.userEmail && ['resolved', 'closed', 'in-progress'].includes(status)) {
        notifications.notifyUserOfStatusChange(ticket).catch(err =>
            console.error('User notification failed:', err.message)
        );
    }

    res.json({ ticket });
});

app.get('/api/analytics', requireAdmin, (req, res) => {
    const days = parseInt(req.query.days) || 30;
    res.json(db.getAnalytics(days));
});

app.get('/api/analytics/export.csv', requireAdmin, (req, res) => {
    const interactions = db.getInteractions(10000);

    const headers = [
        'id', 'createdAt', 'userName', 'department', 'question', 'answer',
        'category', 'confidence', 'escalated', 'ticketId', 'rating',
        'responseTimeMs', 'sources'
    ];

    const escape = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v).replace(/"/g, '""');
        return /[",\n]/.test(s) ? `"${s}"` : s;
    };

    const rows = [
        headers.join(','),
        ...interactions.map(i => headers.map(h => {
            if (h === 'sources') return escape((i.sources || []).join('; '));
            return escape(i[h]);
        }).join(','))
    ];

    const date = new Date().toISOString().substring(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="pmo-chatbot-logs-${date}.csv"`);
    res.send(rows.join('\n'));
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        version: '2.0.0',
        documents: docs.getCount(),
        uptime: Math.round(process.uptime())
    });
});

app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

async function start() {
    if (!process.env.OPENAI_API_KEY) {
        console.warn('OPENAI_API_KEY not set in .env - the chatbot will fail on /api/ask');
    }

    notifications.init();
    await docs.init();

    app.listen(PORT, () => {
        console.log(`PMO Chatbot server running on port ${PORT}`);
        console.log(`  Chatbot:   http://localhost:${PORT}/`);
        console.log(`  Dashboard: http://localhost:${PORT}/dashboard.html`);
        console.log(`  Health:    http://localhost:${PORT}/api/health`);
        if (process.env.ADMIN_TOKEN) {
            console.log(`  Admin token is set in .env`);
        } else {
            console.log(`  Warning: ADMIN_TOKEN not set in .env - dashboard will be inaccessible`);
        }
    });
}

start();
