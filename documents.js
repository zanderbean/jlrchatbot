const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const DOCS_DIR = path.join(__dirname, 'documents');

let documents = new Map();

async function loadFile(filePath) {
    const name = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    try {
        let content = '';

        if (ext === '.txt' || ext === '.md') {
            content = fs.readFileSync(filePath, 'utf-8');
        } else if (ext === '.pdf') {
            const buffer = fs.readFileSync(filePath);
            const data = await pdfParse(buffer);
            content = data.text;
        } else if (ext === '.docx') {
            const result = await mammoth.extractRawText({ path: filePath });
            content = result.value;
        } else {
            return null;
        }

        const chunks = chunkContent(content, name);

        const doc = {
            name,
            content,
            chunks,
            lastModified: fs.statSync(filePath).mtime.toISOString(),
            size: content.length
        };

        documents.set(name, doc);
        console.log(`  Indexed: ${name} (${content.length} chars, ${chunks.length} chunks)`);
        return doc;
    } catch (err) {
        console.log(`  Error loading ${name}: ${err.message}`);
        return null;
    }
}

function chunkContent(content, docName) {
    const CHUNK_SIZE = 800;
    const OVERLAP = 150;
    const chunks = [];

    const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 20);

    let currentChunk = '';
    for (const para of paragraphs) {
        if (currentChunk.length + para.length > CHUNK_SIZE && currentChunk.length > 0) {
            chunks.push({ docName, content: currentChunk.trim() });
            currentChunk = currentChunk.slice(-OVERLAP) + '\n\n' + para;
        } else {
            currentChunk += (currentChunk ? '\n\n' : '') + para;
        }
    }
    if (currentChunk.trim()) {
        chunks.push({ docName, content: currentChunk.trim() });
    }

    return chunks;
}

async function init() {
    if (!fs.existsSync(DOCS_DIR)) {
        fs.mkdirSync(DOCS_DIR, { recursive: true });
        createSampleDocument();
    }

    console.log(`Loading documents from ${DOCS_DIR}`);

    const files = fs.readdirSync(DOCS_DIR);
    for (const file of files) {
        await loadFile(path.join(DOCS_DIR, file));
    }

    console.log(`${documents.size} documents indexed`);

    const watcher = chokidar.watch(DOCS_DIR, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 1000 }
    });

    watcher.on('add', async (filePath) => {
        console.log(`New file detected: ${path.basename(filePath)}`);
        await loadFile(filePath);
    });

    watcher.on('change', async (filePath) => {
        console.log(`File updated: ${path.basename(filePath)}`);
        await loadFile(filePath);
    });

    watcher.on('unlink', (filePath) => {
        const name = path.basename(filePath);
        documents.delete(name);
        console.log(`File removed: ${name}`);
    });

    console.log('Watching documents folder for changes');
}

function search(query, topK = 4) {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const scores = [];

    for (const doc of documents.values()) {
        for (const chunk of doc.chunks) {
            const text = chunk.content.toLowerCase();
            let score = 0;

            for (const term of terms) {
                const matches = (text.match(new RegExp(escapeRegex(term), 'g')) || []).length;
                score += matches;
            }

            if (text.includes(query.toLowerCase())) {
                score += 10;
            }

            if (score > 0) {
                scores.push({ ...chunk, score });
            }
        }
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, topK);
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createSampleDocument() {
    const sample = `PMO Programme Management Handbook - Sample

REPORTING STANDARDS
All programme status reports must be submitted by the 5th working day of each month.
Reports should use the standard PMO template found on the PMO SharePoint site.
Reports must include: RAG status, key milestones, risks and issues, and resource updates.

RAG STATUS DEFINITIONS
- GREEN: On track. No issues expected.
- AMBER: Some concerns, recoverable with current plan.
- RED: Significant issues. Escalation required.

CHANGE CONTROL PROCESS
1. Raise a change request via the CR form.
2. CR is reviewed by the Programme Manager.
3. Changes over 50,000 pounds or affecting more than 2 workstreams require Change Control Board approval.
4. Approved changes are logged in the CR register.

GATE REVIEWS
The programme follows a 5-gate governance model:
Gate 0 - Strategic Assessment
Gate 1 - Business Case
Gate 2 - Delivery Strategy
Gate 3 - Investment Decision
Gate 4 - Readiness for Service

GLOSSARY
- Milestone: A significant event or decision point in the programme.
- Risk: An uncertain event that may impact programme objectives.
- Issue: A problem currently affecting programme delivery.
- Dependency: A relationship where one task or deliverable relies on another.

CONTACTING PMO
- General queries: pmo@company.com
- Urgent escalations: call the PMO duty phone +44 20 1234 5678
- SLA: Responses within 2 working days for standard queries, 4 hours for urgent.`;

    fs.writeFileSync(path.join(DOCS_DIR, 'pmo-handbook-sample.txt'), sample);
    console.log('  Created sample document: pmo-handbook-sample.txt');
}

module.exports = {
    init,
    search,
    getAll: () => Array.from(documents.values()).map(d => ({
        name: d.name,
        size: d.size,
        chunks: d.chunks.length,
        lastModified: d.lastModified
    })),
    getCount: () => documents.size
};
