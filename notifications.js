const nodemailer = require('nodemailer');

let transporter = null;
let smtpEnabled = false;

function init() {
    if (!process.env.SMTP_HOST) {
        console.log('SMTP not configured, email notifications will log to console only');
        return;
    }

    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });

    smtpEnabled = true;
    console.log(`Email notifications enabled via ${process.env.SMTP_HOST}`);
}

async function sendEmail(to, subject, html) {
    if (!smtpEnabled) {
        console.log('\n[EMAIL SIMULATION]');
        console.log(`  To: ${to}`);
        console.log(`  Subject: ${subject}`);
        console.log(`  Preview: ${html.replace(/<[^>]+>/g, '').substring(0, 100)}...\n`);
        return { simulated: true };
    }

    try {
        const result = await transporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to, subject, html
        });
        return { sent: true, messageId: result.messageId };
    } catch (err) {
        console.error('Email send failed:', err.message);
        return { error: err.message };
    }
}

function ticketCreatedHtml(ticket) {
    return `
<div style="font-family: Segoe UI, Arial, sans-serif; max-width: 600px;">
    <div style="background: #005A8B; color: white; padding: 20px;">
        <h2 style="margin:0;">New PMO Chatbot Ticket</h2>
        <p style="margin:6px 0 0; opacity: 0.9; font-size: 14px;">Priority: ${ticket.priority.toUpperCase()}</p>
    </div>
    <div style="padding: 20px; background: white; border: 1px solid #e2e6ea; border-top: none;">
        <table style="width:100%; border-collapse: collapse;">
            <tr><td style="padding: 6px 0; font-weight: 600; width: 120px;">Ticket ID:</td><td><code>${ticket.id}</code></td></tr>
            <tr><td style="padding: 6px 0; font-weight: 600;">From:</td><td>${ticket.userName}</td></tr>
            <tr><td style="padding: 6px 0; font-weight: 600;">Department:</td><td>${ticket.department || 'Not specified'}</td></tr>
            <tr><td style="padding: 6px 0; font-weight: 600;">Category:</td><td>${ticket.category}</td></tr>
            <tr><td style="padding: 6px 0; font-weight: 600;">Created:</td><td>${new Date(ticket.createdAt).toLocaleString('en-GB')}</td></tr>
        </table>
        <hr style="border: none; border-top: 1px solid #e2e6ea; margin: 16px 0;">
        <h3 style="margin: 0 0 8px; font-size: 15px;">Question:</h3>
        <p style="margin: 0; padding: 12px; background: #f4f6f9; border-left: 3px solid #005A8B; border-radius: 4px;">
            ${ticket.question}
        </p>
        <p style="margin: 20px 0 0; font-size: 13px; color: #6b7280;">
            Please respond within the PMO SLA (2 working days for standard queries).
        </p>
    </div>
</div>`;
}

function ticketUpdatedHtml(ticket) {
    const statusColors = {
        'in-progress': '#1e40af',
        'resolved': '#065f46',
        'closed': '#6b7280'
    };
    const color = statusColors[ticket.status] || '#005A8B';

    return `
<div style="font-family: Segoe UI, Arial, sans-serif; max-width: 600px;">
    <div style="background: ${color}; color: white; padding: 20px;">
        <h2 style="margin:0;">PMO Ticket Update</h2>
        <p style="margin:6px 0 0; opacity: 0.9;">Status: ${ticket.status.toUpperCase()}</p>
    </div>
    <div style="padding: 20px; background: white; border: 1px solid #e2e6ea; border-top: none;">
        <p>Hello ${ticket.userName || 'there'},</p>
        <p>Your PMO ticket <code>${ticket.id}</code> has been updated to <strong>${ticket.status}</strong>.</p>
        ${ticket.resolution ? `
            <div style="margin: 16px 0; padding: 12px; background: #f0fdf4; border-left: 3px solid #065f46; border-radius: 4px;">
                <strong>Resolution:</strong><br>
                ${ticket.resolution}
            </div>
        ` : ''}
        <p style="font-size: 13px; color: #6b7280; margin-top: 20px;">
            Your original question: <em>"${ticket.question}"</em>
        </p>
    </div>
</div>`;
}

module.exports = {
    init,
    notifyPMOTeamOfTicket: async (ticket) => {
        const pmoEmail = process.env.PMO_TEAM_EMAIL || 'pmo@company.com';
        return sendEmail(
            pmoEmail,
            `[PMO Chatbot] New ${ticket.priority} priority ticket: ${ticket.id}`,
            ticketCreatedHtml(ticket)
        );
    },
    notifyUserOfTicketCreated: async (ticket) => {
        if (!ticket.userEmail) return { skipped: 'no email' };
        return sendEmail(
            ticket.userEmail,
            `PMO ticket ${ticket.id} received`,
            ticketCreatedHtml(ticket)
        );
    },
    notifyUserOfStatusChange: async (ticket) => {
        if (!ticket.userEmail) return { skipped: 'no email' };
        return sendEmail(
            ticket.userEmail,
            `PMO ticket ${ticket.id} - ${ticket.status}`,
            ticketUpdatedHtml(ticket)
        );
    }
};
