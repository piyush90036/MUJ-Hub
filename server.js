require('dotenv').config({ path: './gemini.env' });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { randomUUID } = crypto;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;

// Ensure the 'uploads' folder actually exists on your computer
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Set up Multer to handle real physical file inputs locally
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// Initialize Gemini SDKs
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.json());

// --- LIVE DATABASES (In-Memory for MVP) ---
let dbEvents = [];
let dbNotes = [];
let dbPlacements = [];
let dbAlumni = [
    {
        id: 1,
        author: "Rahul Singh",
        batch: "Class of 2023",
        company: "Software Engineer @ Amazon",
        text: "Amazon off-campus drive is next month. Focus heavily on Trees and Graphs for the OA. Let me know if anyone needs a referral!",
        date: "Just now",
        replies: []
    }
];

// --- AUTH (in-memory; matches public/index.html API) ---
let authUsers = [];
const authSessions = new Map();
const studentToTeacher = new Map();

function hashPassword(pw) {
    return crypto.createHash('sha256').update(String(pw), 'utf8').digest('hex');
}

function newSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

function getUserFromBearer(req) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return null;
    const token = h.slice(7);
    const sess = authSessions.get(token);
    if (!sess) return null;
    return authUsers.find((u) => u.id === sess.userId) || null;
}

function seedSuperAdmin() {
    if (authUsers.length) return;
    const loginId = process.env.SUPERADMIN_LOGIN || process.env.SUPERADMIN_ID || 'superadmin';
    const password = process.env.SUPERADMIN_PASSWORD || 'admin123';
    authUsers.push({
        id: 'u-superadmin',
        loginId,
        name: 'Super Admin',
        role: 'superadmin',
        passwordHash: hashPassword(password),
    });
}
seedSuperAdmin();

function requireSuperAdmin(req, res, next) {
    const user = getUserFromBearer(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (user.role !== 'superadmin') return res.status(403).json({ error: 'Forbidden' });
    req.authUser = user;
    next();
}

app.post('/api/auth/login', (req, res) => {
    const { loginId, password } = req.body || {};
    if (!loginId || !password) {
        return res.status(400).json({ error: 'loginId and password required' });
    }
    const user = authUsers.find((u) => u.loginId === loginId);
    if (!user || user.passwordHash !== hashPassword(password)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = newSessionToken();
    authSessions.set(token, { userId: user.id });
    res.json({ token, user: { name: user.name, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) authSessions.delete(h.slice(7));
    res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
    const user = getUserFromBearer(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ user: { name: user.name, role: user.role } });
});

app.get('/api/superadmin/users', requireSuperAdmin, (req, res) => {
    const users = authUsers.map((u) => ({
        id: u.id,
        loginId: u.loginId,
        name: u.name,
        role: u.role,
    }));
    res.json({ users });
});

app.post('/api/superadmin/create-user', requireSuperAdmin, (req, res) => {
    const { role, loginId, name, password } = req.body || {};
    if (!role || !loginId || !name || !password) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    const r = String(role).toLowerCase();
    if (!['student', 'teacher', 'alumni'].includes(r)) {
        return res.status(400).json({ error: 'Invalid role' });
    }
    if (authUsers.some((u) => u.loginId === loginId)) {
        return res.status(409).json({ error: 'Login ID already exists' });
    }
    const u = {
        id: randomUUID(),
        loginId,
        name,
        role: r,
        passwordHash: hashPassword(password),
    };
    authUsers.push(u);
    res.json({ user: { id: u.id, loginId: u.loginId, name: u.name, role: u.role } });
});

app.post('/api/superadmin/allocate-teacher', requireSuperAdmin, (req, res) => {
    const { studentId, teacherId } = req.body || {};
    if (!studentId || !teacherId) {
        return res.status(400).json({ error: 'studentId and teacherId required' });
    }
    const s = authUsers.find((u) => u.id === studentId && u.role === 'student');
    const t = authUsers.find((u) => u.id === teacherId && u.role === 'teacher');
    if (!s || !t) return res.status(400).json({ error: 'Invalid student or teacher' });
    studentToTeacher.set(studentId, teacherId);
    res.json({ ok: true });
});

app.delete('/api/superadmin/users/:userId', requireSuperAdmin, (req, res) => {
    const userId = req.params.userId;
    const idx = authUsers.findIndex((u) => u.id === userId);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const u = authUsers[idx];
    if (u.role === 'superadmin') {
        return res.status(400).json({ error: 'Cannot delete superadmin' });
    }
    authUsers.splice(idx, 1);
    studentToTeacher.delete(userId);
    for (const [sid, tid] of [...studentToTeacher.entries()]) {
        if (tid === userId) studentToTeacher.delete(sid);
    }
    res.json({ ok: true });
});

// --- WEBSOCKETS (Real-Time Campus Syncing) ---
io.on('connection', (socket) => {
    // 1. Sync all data immediately upon a user logging in
    socket.emit('sync-events', dbEvents);
    socket.emit('sync-notes', dbNotes);
    socket.emit('sync-alumni', dbAlumni);
    socket.emit('sync-placements', dbPlacements);

    // 2. Listen for Calendar Events
    socket.on('new-event', (eventData) => {
        dbEvents.push(eventData);
        io.emit('sync-events', dbEvents);
    });

    // 3. Listen for Alumni Posts & Threaded Replies
    socket.on('new-alumni-post', (postData) => {
        postData.replies = []; // Ensure replies array exists
        dbAlumni.unshift(postData);
        io.emit('sync-alumni', dbAlumni);
    });

    socket.on('new-alumni-reply', (replyData) => {
        const post = dbAlumni.find(p => p.id === replyData.postId);
        if (post) {
            post.replies.push({ author: replyData.author, text: replyData.text, role: replyData.role });
            io.emit('sync-alumni', dbAlumni);
        }
    });

    // 4. Listen for Placement Notices
    socket.on('new-placement-notice', (noticeData) => {
        dbPlacements.unshift(noticeData);
        io.emit('sync-placements', dbPlacements);
    });
});

// --- ROUTE: DUAL FILE UPLOAD (Local + Gemini) ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let geminiFileUri = null;
    let geminiMimeType = req.file.mimetype;

    try {
        console.log(`📤 Silently sending ${req.file.originalname} to Gemini AI...`);
        const uploadResponse = await fileManager.uploadFile(req.file.path, {
            mimeType: geminiMimeType,
            displayName: req.file.originalname,
        });
        geminiFileUri = uploadResponse.file.uri;
        console.log("✅ Ready for AI Query! URI:", geminiFileUri);
    } catch (error) {
        console.error("❌ Gemini Upload Error (Rate Limit likely):", error.message);
    }

    const newNote = {
        id: Date.now(),
        title: req.body.title,
        teacher: req.body.teacher,
        filename: req.file.originalname,
        filepath: `/uploads/${req.file.filename}`,
        geminiUri: geminiFileUri,
        mimeType: geminiMimeType,
        docType: req.body.docType || 'notes',
        date: new Date().toLocaleDateString()
    };

    dbNotes.unshift(newNote);
    io.emit('sync-notes', dbNotes); // Live sync to campus feed
    res.json({ success: true, note: newNote });
});

// --- ROUTE: GEMINI AI CHAT (With Rate Limit Safety) ---
app.post('/api/chat', async (req, res) => {
    try {
        const { message, fileUri, mimeType } = req.body;

        // Using the highly available 2.0-flash model
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        let promptContext = [
            "You are a helpful teaching assistant for Manipal University Jaipur. Your goal is to explain the contents of the attached document clearly to a student.",
            `Student asks: ${message}`
        ];

        // If a file reference was sent, force Gemini to read it
        if (fileUri) {
            promptContext.unshift({
                fileData: { mimeType: mimeType, fileUri: fileUri }
            });
        }

        const result = await model.generateContent(promptContext);
        res.json({ reply: result.response.text() });

    } catch (error) {
        console.error("Gemini API Error:", error.message);

        // Custom handler to gracefully catch the Free Tier 'Too Many Requests' error
        if (error.status === 429) {
            return res.status(429).json({ error: "AI quota exceeded. Please wait 60 seconds before asking another question." });
        }
        res.status(500).json({ error: "AI encountered an issue reading the file. Try again." });
    }
});

// Start the engine
server.listen(PORT, () => {
    console.log(`🚀 Live MUJ Hub Server running at http://localhost:${PORT}`);
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the other process or set PORT=3001 and try again.`);
    } else {
        console.error(err);
    }
    process.exit(1);
});
