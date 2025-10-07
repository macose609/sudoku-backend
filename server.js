const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 5000;

// Serve static files
app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Game state
const gameState = {
    players: {}, // { socketId: { slot, name, lock, score, completed, finished, board, solution } }
    maxPlayers: 4,
    slots: [false, false, false, false], // slot availability
    pendingPlayers: {}, // { socketId: { name, lock } } - waiting for lock approval
    stats: {
        totalPlayers: 0,
        gamesPlayed: 0,
        totalTime: 0
    }
};

// Admin connections
const adminSockets = new Set();

// Generate random lock code
function generateLock() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // Send current game state
    socket.emit('gameState', getPublicGameState());

    // ============================================
    // PLAYER LOCK SYSTEM
    // ============================================

    // Player requests lock
    socket.on('requestLock', (data) => {
        const lock = generateLock();
        
        gameState.pendingPlayers[socket.id] = {
            name: data.name,
            lock: lock,
            timestamp: Date.now()
        };

        console.log(`Player ${data.name} (${socket.id}) requested lock: ${lock}`);

        // Send lock to player
        socket.emit('lockAssigned', { lock: lock });

        // Notify admins about new player request
        adminSockets.forEach(adminId => {
            io.to(adminId).emit('playerRequest', {
                playerId: socket.id,
                name: data.name,
                lock: lock
            });
        });
    });

    // Player verified lock
    socket.on('lockVerified', (data) => {
        const pending = gameState.pendingPlayers[socket.id];
        
        if (!pending || pending.lock !== data.lock) {
            socket.emit('lockError', 'الرمز غير صحيح');
            return;
        }

        console.log(`Player ${data.name} verified lock successfully`);
        
        // Keep in pending until they select a slot
        socket.emit('gameState', getPublicGameState());
    });

    // ============================================
    // ADMIN EVENTS
    // ============================================

    socket.on('adminLogin', () => {
        adminSockets.add(socket.id);
        console.log('Admin logged in:', socket.id);
        
        socket.emit('gameState', getPublicGameState());
        socket.emit('adminStats', gameState.stats);
        
        // Send pending players list
        socket.emit('pendingPlayers', Object.keys(gameState.pendingPlayers).map(id => ({
            id,
            ...gameState.pendingPlayers[id]
        })));
    });

    socket.on('adminKickPlayer', (playerId) => {
        if (!adminSockets.has(socket.id)) return;
        
        console.log(`Admin ${socket.id} kicking player ${playerId}`);
        
        if (gameState.players[playerId]) {
            const slot = gameState.players[playerId].slot;
            gameState.slots[slot - 1] = false;
            delete gameState.players[playerId];
            
            io.to(playerId).emit('kicked', { message: 'تم طردك من قبل المسؤول' });
            io.to(playerId).disconnectSockets(true);
            
            io.emit('gameState', getPublicGameState());
            io.to(socket.id).emit('playerLeft', { playerId });
        }
    });

    socket.on('adminResetPlayer', (playerId) => {
        if (!adminSockets.has(socket.id)) return;
        
        console.log(`Admin ${socket.id} resetting player ${playerId}`);
        
        if (gameState.players[playerId]) {
            gameState.players[playerId].score = 0;
            gameState.players[playerId].completed = 0;
            gameState.players[playerId].finished = false;
            gameState.players[playerId].board = null;
            gameState.players[playerId].solution = null;
            
            io.to(playerId).emit('resetGame');
            io.emit('gameState', getPublicGameState());
        }
    });

    socket.on('adminResetAll', () => {
        if (!adminSockets.has(socket.id)) return;
        
        console.log(`Admin ${socket.id} resetting all games`);
        
        for (let playerId in gameState.players) {
            gameState.players[playerId].score = 0;
            gameState.players[playerId].completed = 0;
            gameState.players[playerId].finished = false;
            gameState.players[playerId].board = null;
            gameState.players[playerId].solution = null;
        }

        io.emit('resetGame');
        io.emit('gameState', getPublicGameState());
    });

    socket.on('adminKickAll', () => {
        if (!adminSockets.has(socket.id)) return;
        
        console.log(`Admin ${socket.id} kicking all players`);
        
        const playerIds = Object.keys(gameState.players);
        
        playerIds.forEach(playerId => {
            io.to(playerId).emit('kicked', { message: 'تم إنهاء اللعبة من قبل المسؤول' });
            io.to(playerId).disconnectSockets(true);
        });
        
        gameState.players = {};
        gameState.slots = [false, false, false, false];
        
        io.emit('gameState', getPublicGameState());
    });

    socket.on('adminRefresh', () => {
        if (!adminSockets.has(socket.id)) return;
        
        socket.emit('gameState', getPublicGameState());
        socket.emit('adminStats', gameState.stats);
        socket.emit('pendingPlayers', Object.keys(gameState.pendingPlayers).map(id => ({
            id,
            ...gameState.pendingPlayers[id]
        })));
    });

    // ============================================
    // PLAYER GAME EVENTS
    // ============================================

    socket.on('requestSlot', (data) => {
        const slotNumber = data.slot;
        const pending = gameState.pendingPlayers[socket.id];
        
        // Verify lock
        if (!pending || pending.lock !== data.lock) {
            socket.emit('slotError', 'الرمز غير صحيح');
            return;
        }

        console.log(`Socket ${socket.id} requests slot ${slotNumber}`);
        
        if (slotNumber < 1 || slotNumber > 4) {
            socket.emit('slotError', 'رقم المكان غير صحيح');
            return;
        }

        if (Object.keys(gameState.players).length >= 4) {
            socket.emit('slotError', 'اللعبة ممتلئة! (4/4)');
            return;
        }

        const slotTaken = Object.values(gameState.players).some(p => p.slot === slotNumber);
        if (slotTaken) {
            socket.emit('slotError', 'هذا المكان محجوز!');
            return;
        }

        // Assign slot
        gameState.players[socket.id] = {
            id: socket.id,
            slot: slotNumber,
            name: data.name,
            lock: data.lock,
            score: 0,
            completed: 0,
            finished: false,
            board: null,
            solution: null,
            online: true,
            joinedAt: Date.now()
        };

        gameState.slots[slotNumber - 1] = true;
        gameState.stats.totalPlayers++;

        // Remove from pending
        delete gameState.pendingPlayers[socket.id];

        socket.emit('slotAssigned', {
            slot: slotNumber,
            playerId: socket.id
        });

        io.emit('gameState', getPublicGameState());
        
        adminSockets.forEach(adminId => {
            io.to(adminId).emit('playerJoined', {
                playerId: socket.id,
                name: data.name,
                slot: slotNumber
            });
        });

        console.log(`Slot ${slotNumber} assigned to ${data.name} (${socket.id})`);
    });

    socket.on('sendBoard', (data) => {
        if (!gameState.players[socket.id]) return;
        
        gameState.players[socket.id].board = data.board;
        gameState.players[socket.id].solution = data.solution;
        
        console.log(`Board received from ${socket.id}`);
    });

    socket.on('updateProgress', (data) => {
        if (!gameState.players[socket.id]) return;

        gameState.players[socket.id].score = data.score;
        gameState.players[socket.id].completed = data.completed;
        gameState.players[socket.id].finished = data.finished;

        io.emit('gameState', getPublicGameState());

        if (data.finished) {
            gameState.stats.gamesPlayed++;
            
            const timePlayed = Math.floor((Date.now() - gameState.players[socket.id].joinedAt) / 1000);
            gameState.stats.totalTime += timePlayed;
            
            console.log(`Player ${socket.id} finished in ${timePlayed}s!`);
            
            io.emit('playerFinished', {
                slot: gameState.players[socket.id].slot,
                playerName: gameState.players[socket.id].name,
                score: data.score
            });

            adminSockets.forEach(adminId => {
                io.to(adminId).emit('gameFinished', {
                    playerId: socket.id,
                    playerName: gameState.players[socket.id].name,
                    time: formatTime(timePlayed),
                    score: data.score
                });
            });
        }
    });

    socket.on('newGame', () => {
        for (let playerId in gameState.players) {
            gameState.players[playerId].score = 0;
            gameState.players[playerId].completed = 0;
            gameState.players[playerId].finished = false;
            gameState.players[playerId].board = null;
            gameState.players[playerId].solution = null;
            gameState.players[playerId].joinedAt = Date.now();
        }

        io.emit('resetGame');
        io.emit('gameState', getPublicGameState());
        console.log('New game started');
    });

    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        
        adminSockets.delete(socket.id);
        
        // Remove from pending
        if (gameState.pendingPlayers[socket.id]) {
            delete gameState.pendingPlayers[socket.id];
        }
        
        // Remove from players
        if (gameState.players[socket.id]) {
            const slot = gameState.players[socket.id].slot;
            const name = gameState.players[socket.id].name;
            gameState.slots[slot - 1] = false;
            delete gameState.players[socket.id];
            
            io.emit('gameState', getPublicGameState());
            
            adminSockets.forEach(adminId => {
                io.to(adminId).emit('playerLeft', {
                    playerId: socket.id,
                    name: name
                });
            });
            
            console.log(`${name} left - Slot ${slot} is now available`);
        }
    });
});

function getPublicGameState() {
    const publicPlayers = {};
    
    for (let playerId in gameState.players) {
        const player = gameState.players[playerId];
        publicPlayers[playerId] = {
            id: playerId,
            slot: player.slot,
            name: player.name,
            score: player.score,
            completed: player.completed,
            finished: player.finished,
            online: player.online
        };
    }

    return {
        players: publicPlayers,
        maxPlayers: gameState.maxPlayers,
        onlineCount: Object.keys(gameState.players).length,
        availableSlots: gameState.slots.map((taken, idx) => !taken ? idx + 1 : null).filter(s => s !== null),
        stats: gameState.stats
    };
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🎮 Sudoku 4-Player Game Server`);
    console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
    console.log(`🎯 Game: http://localhost:${PORT}/`);
});
