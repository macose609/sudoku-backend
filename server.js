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

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

// Game state
const gameState = {
    players: {}, // { socketId: { slot, name, score, completed, finished, board, solution } }
    maxPlayers: 4,
    slots: [false, false, false, false] // slot availability
};

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // Send current game state
    socket.emit('gameState', getPublicGameState());

    // Request slot
    socket.on('requestSlot', (slotNumber) => {
        console.log(`Socket ${socket.id} requests slot ${slotNumber}`);
        
        // Check if slot is available
        if (slotNumber < 1 || slotNumber > 4) {
            socket.emit('slotError', 'رقم المكان غير صحيح');
            return;
        }

        // Check if game is full
        if (Object.keys(gameState.players).length >= 4) {
            socket.emit('slotError', 'اللعبة ممتلئة! (4/4)');
            return;
        }

        // Check if slot is taken
        const slotTaken = Object.values(gameState.players).some(p => p.slot === slotNumber);
        if (slotTaken) {
            socket.emit('slotError', 'هذا المكان محجوز!');
            return;
        }

        // Assign slot
        gameState.players[socket.id] = {
            slot: slotNumber,
            name: `لاعب ${slotNumber}`,
            score: 0,
            completed: 0,
            finished: false,
            board: null,
            solution: null,
            online: true
        };

        gameState.slots[slotNumber - 1] = true;

        // Notify player
        socket.emit('slotAssigned', {
            slot: slotNumber,
            playerId: socket.id
        });

        // Broadcast to all
        io.emit('gameState', getPublicGameState());
        console.log(`Slot ${slotNumber} assigned to ${socket.id}`);
    });

    // Receive board from player
    socket.on('sendBoard', (data) => {
        if (!gameState.players[socket.id]) return;
        
        gameState.players[socket.id].board = data.board;
        gameState.players[socket.id].solution = data.solution;
        
        console.log(`Board received from ${socket.id}`);
    });

    // Update player progress
    socket.on('updateProgress', (data) => {
        if (!gameState.players[socket.id]) return;

        gameState.players[socket.id].score = data.score;
        gameState.players[socket.id].completed = data.completed;
        gameState.players[socket.id].finished = data.finished;

        // Broadcast updated state
        io.emit('gameState', getPublicGameState());

        if (data.finished) {
            console.log(`Player ${socket.id} finished!`);
            io.emit('playerFinished', {
                slot: gameState.players[socket.id].slot,
                score: data.score
            });
        }
    });

    // New game request
    socket.on('newGame', () => {
        // Reset all players
        for (let playerId in gameState.players) {
            gameState.players[playerId].score = 0;
            gameState.players[playerId].completed = 0;
            gameState.players[playerId].finished = false;
            gameState.players[playerId].board = null;
            gameState.players[playerId].solution = null;
        }

        io.emit('resetGame');
        io.emit('gameState', getPublicGameState());
        console.log('New game started');
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        
        if (gameState.players[socket.id]) {
            const slot = gameState.players[socket.id].slot;
            gameState.slots[slot - 1] = false;
            delete gameState.players[socket.id];
            
            io.emit('gameState', getPublicGameState());
            console.log(`Slot ${slot} is now available`);
        }
    });
});

// Helper function to get public game state
function getPublicGameState() {
    const publicPlayers = {};
    
    for (let playerId in gameState.players) {
        const player = gameState.players[playerId];
        publicPlayers[playerId] = {
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
        availableSlots: gameState.slots.map((taken, idx) => !taken ? idx + 1 : null).filter(s => s !== null)
    };
}

server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🎮 Sudoku 4-Player Game Server`);
});
