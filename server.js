// server.js - Backend Socket.IO pour SuperQuiz Deluxe v2 Online Pro
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const admin = require('firebase-admin');
const cors = require('cors');

// ====================== INITIALISATION FIREBASE ADMIN ======================
const serviceAccount = require('./serviceAccountKey.json'); // ← À télécharger depuis Firebase Console

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: "whatquiz-porf"
});

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // À restreindre en prod : ["https://ton-domaine.com"]
        methods: ["GET", "POST"]
    }
});

// ====================== GESTION DES ROOMS LIVE ======================
const liveRooms = new Map(); // code → room object

function generateCode() {
    return 'QZ-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ====================== MIDDLEWARE AUTH SOCKET.IO ======================
io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
        return next(new Error('Token d\'authentification manquant'));
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        socket.user = {
            uid: decodedToken.uid,
            email: decodedToken.email,
            name: decodedToken.name || decodedToken.email?.split('@')[0] || 'Anonyme',
            role: decodedToken.role || 'student' // custom claim
        };
        next();
    } catch (error) {
        console.error('Erreur vérification token:', error);
        next(new Error('Token invalide ou expiré'));
    }
});

// ====================== CONNEXION SOCKET ======================
io.on('connection', (socket) => {
    console.log(`Utilisateur connecté: ${socket.user.uid} (${socket.user.role})`);

    // ==================== PROF : CRÉER UN LIVE ====================
    socket.on('createLive', async ({ quizId }, callback) => {
        if (socket.user.role !== 'teacher') {
            return callback({ error: 'Seuls les professeurs peuvent créer un live' });
        }

        try {
            const quizDoc = await admin.firestore().collection('quizzes').doc(quizId).get();
            if (!quizDoc.exists) {
                return callback({ error: 'Quiz introuvable' });
            }

            const quizData = quizDoc.data();
            if (quizData.ownerUid !== socket.user.uid) {
                return callback({ error: 'Vous n\'êtes pas le propriétaire de ce quiz' });
            }

            // Création du code unique
            let code;
            do {
                code = generateCode();
            } while (liveRooms.has(code));

            const room = {
                code,
                hostSocket: socket,
                quizId,
                quiz: quizData,
                currentIndex: 0,
                participants: new Map() // uid → { name, score, answers }
            };

            liveRooms.set(code, room);
            socket.join(code);

            console.log(`Live créé par ${socket.user.uid} - Code: ${code}`);

            callback({ code });
            socket.emit('liveCreated', { code });
        } catch (error) {
            console.error('Erreur création live:', error);
            callback({ error: 'Erreur serveur' });
        }
    });

    // ==================== ÉLÈVE : REJOINDRE UN LIVE ====================
    socket.on('joinLive', ({ code }, callback) => {
        const room = liveRooms.get(code.toUpperCase());

        if (!room) {
            return callback({ error: 'Code invalide ou live terminé' });
        }

        socket.join(code);

        const participant = {
            name: socket.user.name,
            score: 0,
            answers: {}
        };

        room.participants.set(socket.user.uid, participant);

        // Notifier le prof qu'un élève a rejoint
        room.hostSocket.emit('studentJoined', { name: participant.name, count: room.participants.size });

        // Notifier tous les élèves (sauf le nouveau) qu'un nouveau est arrivé
        socket.to(code).emit('studentJoined', { name: participant.name, count: room.participants.size });

        console.log(`${socket.user.name} a rejoint le live ${code}`);

        callback({ success: true });

        // Envoyer la question courante si le live a déjà commencé
        if (room.currentIndex > 0) {
            const currentQ = room.quiz.questions[room.currentIndex - 1];
            socket.emit('newQuestion', {
                question: currentQ,
                index: room.currentIndex - 1
            });
        }
    });

    // ==================== PROF : QUESTION SUIVANTE ====================
    socket.on('nextQuestion', ({ code }) => {
        const room = liveRooms.get(code);
        if (!room || room.hostSocket !== socket) {
            return;
        }

        if (room.currentIndex >= room.quiz.questions.length) {
            // Fin automatique du quiz
            io.to(code).emit('liveEnded', { reason: 'quiz_completed' });
            console.log(`Live ${code} terminé (quiz fini)`);
            liveRooms.delete(code);
            return;
        }

        const question = room.quiz.questions[room.currentIndex];
        room.currentIndex++;

        io.to(code).emit('newQuestion', {
            question,
            index: room.currentIndex - 1
        });

        console.log(`Question ${room.currentIndex} envoyée dans le live ${code}`);
    });

    // ==================== ÉLÈVE : SOUMETTRE RÉPONSE ====================
    socket.on('submitAnswer', ({ code, answerIndex }) => {
        const room = liveRooms.get(code);
        if (!room) return;

        const participant = room.participants.get(socket.user.uid);
        if (!participant) return;

        const currentQuestionIndex = room.currentIndex - 1;
        const question = room.quiz.questions[currentQuestionIndex];

        participant.answers[currentQuestionIndex] = answerIndex;

        const isCorrect = question.correct.includes(answerIndex);
        if (isCorrect) {
            participant.score++;
        }

        // Notifier le prof qu'une réponse a été reçue
        room.hostSocket.emit('answerReceived', {
            name: participant.name,
            correct: isCorrect
        });

        // Optionnel : notifier les autres élèves (pour animation)
        socket.to(code).emit('answerReceived', { name: participant.name });
    });

    // ==================== PROF : TERMINER LE LIVE ====================
    socket.on('endLive', ({ code }) => {
        const room = liveRooms.get(code);
        if (!room || room.hostSocket !== socket) {
            return;
        }

        io.to(code).emit('liveEnded', { reason: 'ended_by_teacher' });
        console.log(`Live ${code} terminé par le professeur`);
        liveRooms.delete(code);
    });

    // ==================== DÉCONNEXION ====================
    socket.on('disconnect', (reason) => {
        console.log(`Déconnexion: ${socket.user.uid} - ${reason}`);

        // Si c'est le prof qui se déconnecte → terminer le live
        for (const [code, room] of liveRooms.entries()) {
            if (room.hostSocket === socket) {
                io.to(code).emit('liveEnded', { reason: 'teacher_disconnected' });
                console.log(`Live ${code} terminé (prof déconnecté)`);
                liveRooms.delete(code);
                break;
            }
        }
    });
});

// ====================== ROUTE DE BASE ======================
app.get('/', (req, res) => {
    res.send('SuperQuiz Deluxe Live Server - En ligne ✅');
});

// ====================== LANCEMENT SERVEUR ======================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Serveur Live démarré sur le port ${PORT}`);
    console.log(`Prêt à gérer les lives en temps réel !`);
});