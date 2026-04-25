const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pmo-data.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let data = {
    sessions: {},
    interactions: [],
    tickets: []
};

function load() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf-8');
            data = JSON.parse(raw);
            console.log(`Loaded ${Object.keys(data.sessions).length} sessions, ${data.interactions.length} interactions, ${data.tickets.length} tickets`);
        }
    } catch (err) {
        console.warn('Could not load data file, starting fresh:', err.message);
    }
}

let saveTimer = null;
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        } catch (err) {
            console.error('Failed to save data:', err.message);
        }
    }, 500);
}

load();

module.exports = {
    createSession: (id, userId, userName, department) => {
        const now = new Date().toISOString();
        data.sessions[id] = {
            id,
            userId: userId || 'anonymous',
            userName: userName || 'Anonymous User',
            department: department || null,
            createdAt: now,
            lastActivity: now,
            messages: []
        };
        save();
    },

    getSession: (id) => data.sessions[id] || null,

    touchSession: (id) => {
        if (data.sessions[id]) {
            data.sessions[id].lastActivity = new Date().toISOString();
            save();
        }
    },

    addMessage: (sessionId, role, content) => {
        const session = data.sessions[sessionId];
        if (!session) return;
        session.messages.push({
            role,
            content,
            timestamp: new Date().toISOString()
        });
        if (session.messages.length > 50) {
            session.messages = session.messages.slice(-50);
        }
        save();
    },

    getSessionHistory: (sessionId, limit = 10) => {
        const session = data.sessions[sessionId];
        if (!session) return [];
        return session.messages.slice(-limit);
    },

    logInteraction: (interaction) => {
        data.interactions.push({
            ...interaction,
            createdAt: new Date().toISOString()
        });
        if (data.interactions.length > 10000) {
            data.interactions = data.interactions.slice(-10000);
        }
        save();
    },

    rateInteraction: (id, rating, feedback) => {
        const interaction = data.interactions.find(i => i.id === id);
        if (!interaction) return false;
        interaction.rating = rating;
        interaction.ratingFeedback = feedback || null;
        save();
        return true;
    },

    getInteractions: (limit = 100) => {
        return [...data.interactions].reverse().slice(0, limit);
    },

    createTicket: (ticket) => {
        const now = new Date().toISOString();
        data.tickets.push({
            id: ticket.id,
            sessionId: ticket.sessionId,
            userId: ticket.userId,
            userName: ticket.userName,
            userEmail: ticket.userEmail || null,
            department: ticket.department,
            question: ticket.question,
            category: ticket.category,
            priority: ticket.priority || 'medium',
            status: 'open',
            assignedTo: null,
            resolution: null,
            createdAt: now,
            updatedAt: now
        });
        save();
    },

    getTickets: (status) => {
        let tickets = [...data.tickets].reverse();
        if (status) tickets = tickets.filter(t => t.status === status);
        return tickets;
    },

    getTicket: (id) => data.tickets.find(t => t.id === id),

    updateTicket: (id, status, resolution, assignedTo) => {
        const ticket = data.tickets.find(t => t.id === id);
        if (!ticket) return false;
        if (status) ticket.status = status;
        if (resolution !== undefined) ticket.resolution = resolution;
        if (assignedTo !== undefined) ticket.assignedTo = assignedTo;
        ticket.updatedAt = new Date().toISOString();
        save();
        return true;
    },

    getAnalytics: (days = 30) => {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const interactions = data.interactions.filter(i => i.createdAt >= since);

        const totalInteractions = interactions.length;
        const uniqueUsers = new Set(interactions.map(i => i.userId)).size;
        const escalated = interactions.filter(i => i.escalated);
        const escalationRate = totalInteractions > 0 ? escalated.length / totalInteractions : 0;

        const avgConfidence = totalInteractions > 0
            ? interactions.reduce((s, i) => s + (i.confidence || 0), 0) / totalInteractions
            : 0;

        const rated = interactions.filter(i => i.rating);
        const avgRating = rated.length > 0
            ? rated.reduce((s, i) => s + i.rating, 0) / rated.length
            : 0;

        const categoryMap = {};
        interactions.forEach(i => {
            const cat = i.category || 'Other';
            categoryMap[cat] = (categoryMap[cat] || 0) + 1;
        });
        const topCategories = Object.entries(categoryMap)
            .map(([category, count]) => ({ category, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const deptMap = {};
        interactions.forEach(i => {
            if (i.department) deptMap[i.department] = (deptMap[i.department] || 0) + 1;
        });
        const topDepartments = Object.entries(deptMap)
            .map(([department, count]) => ({ department, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const dayMap = {};
        interactions.forEach(i => {
            const day = i.createdAt.substring(0, 10);
            dayMap[day] = (dayMap[day] || 0) + 1;
        });
        const usageByDay = Object.entries(dayMap)
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date));

        const hourMap = {};
        interactions.forEach(i => {
            const hour = new Date(i.createdAt).getHours();
            hourMap[hour] = (hourMap[hour] || 0) + 1;
        });
        const usageByHour = Object.entries(hourMap)
            .map(([hour, count]) => ({ hour: parseInt(hour), count }))
            .sort((a, b) => a.hour - b.hour);

        const recentInteractions = [...interactions]
            .reverse()
            .slice(0, 20)
            .map(i => ({
                id: i.id,
                question: i.question,
                answer: i.answer,
                category: i.category,
                confidence: i.confidence,
                department: i.department,
                userName: i.userName,
                escalated: i.escalated,
                ticketId: i.ticketId,
                rating: i.rating,
                createdAt: i.createdAt
            }));

        return {
            totalInteractions,
            uniqueUsers,
            escalationRate,
            escalations: escalated.length,
            averageConfidence: avgConfidence,
            averageRating: avgRating,
            ratingCount: rated.length,
            topCategories,
            topDepartments,
            usageByDay,
            usageByHour,
            recentInteractions
        };
    }
};
