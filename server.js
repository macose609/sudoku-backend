const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*", // في Production درها domain ديالك
        methods: ["GET", "POST"]
    }
});

// PostgreSQL Connection
const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_CyKxs8Liezc2@ep-morning-rice-aesh599w.c-2.us-east-2.aws.neon.tech/neondb?channel_binding=require&sslmode=require',
    ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());

// Game State في الذاكرة (للسرعة)
let gameRooms = {}; // { roomId: { players: {}, gameData: {} } }

// Initialize Database
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS game_rooms (
                room_id VARCHAR(50) PRIMARY KEY,
                created_at TIMESTAMP DEFAULT NOW(),
                status VARCHAR(20) DEFAULT 'waiting'
            );

            CREATE TABLE IF NOT EXISTS players (
                id SERIAL PRIMARY KEY,
                room_id VARCHAR(50) REFERENCES game_rooms(room_id),
                player_number INTEGER,
                score INTEGER DEFAULT 0,
                board JSONB,
                solution JSONB,
                finished BOOLEAN DEFAULT false,
                finish_time INTEGER,
                joined_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(room_id, player_number)
            );

            CREATE TABLE IF NOT EXISTS game_history (
                id SERIAL PRIMARY KEY,
                room_id VARCHAR(50),
                winner_number INTEGER,
                game_data JSONB,
                completed_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Database initialized');
    } catch (err) {
        console.error('❌ DB Error:', err);
    } finally {
        client.release();
    }
}

// Sudoku Generation Functions
function isValid(board, row, col, num) {
    for (let x = 0; x < 9; x++) {
        if (board[row][x] === num || board[x][col] === num) return false;
    }
    let startRow = row - row % 3, startCol = col - col % 3;
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            if (board[i + startRow][j + startCol] === num) return false;
        }
    }
    return true;
}

function solveSudoku(board) {
    for (let row = 0; row < 9; row++) {
        for (let col = 0; col < 9; col++) {
            if (board[row][col] === 0) {
                for (let num = 1; num <= 9; num++) {
                    if (isValid(board, row, col, num)) {
                        board[row][col] = num;
                        if (solveSudoku(board)) return true;
                        board[row][col] = 0;
                    }
                }
                return false;
            }
        }
    }
    return true;
}

function generateSudoku() {
    const board = Array(9).fill(null).map(() => Array(9).fill(0));
    
    for (let i = 0; i < 15; i++) {
        let num = (i % 9) + 1;
        let attempts = 0;
        while (attempts < 100) {
            let row = Math.floor(Math.random() * 9);
            let col = Math.floor(Math.random() * 9);
            if (board[row][col] === 0 && isValid(board, row, col, num)) {
                board[row][col] = num;
                break;
            }
            attempts++;
        }
    }

    solveSudoku(board);
    const solution = board.map(row => [...row]);
    
    let cellsToRemove = 40;
    let removed = 0;
    while (removed < cellsToRemove) {
        let row = Math.floor(Math.random() * 9);
        let col = Math.floor(Math.random() * 9);
        if (board[row][col] !== 0) {
            board[row][col] = 0;
            removed++;
        }
    }
    
    return { board, solution };
}

// Socket.IO Events
io.on('connection', (socket) => {
    console.log('🔌 Player connected:', socket.id);

    // Join Room
    socket.on('joinRoom', async ({ roomId, playerNumber }) => {
        try {
            // Create room if not exists
            if (!gameRooms[roomId]) {
                gameRooms[roomId] = {
                    players: {},
                    startTime: null,
                    status: 'waiting'
                };

                await pool.query(
                    'INSERT INTO game_rooms (room_id, status) VALUES ($1, $2) ON CONFLICT (room_id) DO NOTHING',
                    [roomId, 'waiting']
                );
            }

            const room = gameRooms[roomId];

            // Check if room is full
            if (Object.keys(room.players).length >= 4) {
                socket.emit('error', { message: 'اللعبة ممتلئة!' });
                return;
            }

            // Check if player number is taken
            if (room.players[playerNumber]) {
                socket.emit('error', { message: 'هذا المكان محجوز!' });
                return;
            }

            // Generate Sudoku for this player
            const { board, solution } = generateSudoku();

            // Add player
            room.players[playerNumber] = {
                socketId: socket.id,
                playerNumber,
                score: 0,
                board,
                solution,
                finished: false,
                finishTime: null,
                completed: 0
            };

            socket.join(roomId);
            socket.roomId = roomId;
            socket.playerNumber = playerNumber;

            // Save to DB
            await pool.query(
                `INSERT INTO players (room_id, player_number, score, board, solution, finished)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (room_id, player_number) 
                 DO UPDATE SET board = $4, solution = $5, finished = false, score = 0`,
                [roomId, playerNumber, 0, JSON.stringify(board), JSON.stringify(solution), false]
            );

            // Start game if this is first player
            if (!room.startTime) {
                room.startTime = Date.now();
                room.status = 'playing';
                await pool.query('UPDATE game_rooms SET status = $1 WHERE room_id = $2', ['playing', roomId]);
            }

            // Send game state to all players
            const playersData = Object.values(room.players).map(p => ({
                playerNumber: p.playerNumber,
                score: p.score,
                completed: p.completed,
                finished: p.finished,
                finishTime: p.finishTime,
                board: p.playerNumber === playerNumber ? p.board : null // فقط اللاعب يشوف board ديالو
            }));

            socket.emit('joinedRoom', {
                roomId,
                playerNumber,
                board,
                players: playersData,
                startTime: room.startTime
            });

            // Notify others
            socket.to(roomId).emit('playerJoined', {
                playerNumber,
                players: playersData
            });

            console.log(`✅ Player ${playerNumber} joined room ${roomId}`);

        } catch (err) {
            console.error('❌ Join error:', err);
            socket.emit('error', { message: 'خطأ في الانضمام!' });
        }
    });

    // Place Number
    socket.on('placeNumber', async ({ roomId, playerNumber, row, col, num }) => {
        try {
            const room = gameRooms[roomId];
            if (!room || !room.players[playerNumber]) return;

            const player = room.players[playerNumber];
            if (player.finished) return;

            // Update board
            player.board[row][col] = num;

            // Check if correct
            const isCorrect = num === player.solution[row][col];
            
            if (isCorrect) {
                player.score += 10;
            } else {
                player.score = Math.max(0, player.score - 2);
            }

            // Count completed cells
            let completed = 0;
            for (let i = 0; i < 9; i++) {
                for (let j = 0; j < 9; j++) {
                    if (player.board[i][j] === player.solution[i][j] && player.board[i][j] !== 0) {
                        completed++;
                    }
                }
            }
            player.completed = completed;

            // Check if finished
            if (completed === 81) {
                player.finished = true;
                player.finishTime = Math.floor((Date.now() - room.startTime) / 1000);
                player.score += 100; // Bonus

                await pool.query(
                    'UPDATE players SET score = $1, finished = $2, finish_time = $3 WHERE room_id = $4 AND player_number = $5',
                    [player.score, true, player.finishTime, roomId, playerNumber]
                );

                // Check if all finished
                const allFinished = Object.values(room.players).every(p => p.finished);
                if (allFinished) {
                    room.status = 'completed';
                    
                    // Save to history
                    const winner = Object.values(room.players).sort((a, b) => {
                        if (a.score !== b.score) return b.score - a.score;
                        return a.finishTime - b.finishTime;
                    })[0];

                    await pool.query(
                        'INSERT INTO game_history (room_id, winner_number, game_data) VALUES ($1, $2, $3)',
                        [roomId, winner.playerNumber, JSON.stringify(room)]
                    );

                    io.to(roomId).emit('gameCompleted', {
                        winner: winner.playerNumber,
                        players: Object.values(room.players).map(p => ({
                            playerNumber: p.playerNumber,
                            score: p.score,
                            finishTime: p.finishTime
                        }))
                    });
                }
            }

            // Update DB
            await pool.query(
                'UPDATE players SET score = $1, board = $2 WHERE room_id = $3 AND player_number = $4',
                [player.score, JSON.stringify(player.board), roomId, playerNumber]
            );

            // Broadcast update
            io.to(roomId).emit('playerUpdate', {
                playerNumber,
                score: player.score,
                completed: player.completed,
                finished: player.finished,
                finishTime: player.finishTime,
                isCorrect,
                row,
                col
            });

        } catch (err) {
            console.error('❌ Place number error:', err);
        }
    });

    // Clear Cell
    socket.on('clearCell', async ({ roomId, playerNumber, row, col }) => {
        try {
            const room = gameRooms[roomId];
            if (!room || !room.players[playerNumber]) return;

            const player = room.players[playerNumber];
            if (player.finished) return;

            player.board[row][col] = 0;

            await pool.query(
                'UPDATE players SET board = $1 WHERE room_id = $2 AND player_number = $3',
                [JSON.stringify(player.board), roomId, playerNumber]
            );

            io.to(roomId).emit('cellCleared', { playerNumber, row, col });

        } catch (err) {
            console.error('❌ Clear cell error:', err);
        }
    });

    // Leave Room
    socket.on('leaveRoom', async ({ roomId, playerNumber }) => {
        try {
            const room = gameRooms[roomId];
            if (room && room.players[playerNumber]) {
                delete room.players[playerNumber];

                await pool.query(
                    'DELETE FROM players WHERE room_id = $1 AND player_number = $2',
                    [roomId, playerNumber]
                );

                socket.leave(roomId);

                // Notify others
                io.to(roomId).emit('playerLeft', { playerNumber });

                // Delete room if empty
                if (Object.keys(room.players).length === 0) {
                    delete gameRooms[roomId];
                    await pool.query('DELETE FROM game_rooms WHERE room_id = $1', [roomId]);
                }

                console.log(`👋 Player ${playerNumber} left room ${roomId}`);
            }
        } catch (err) {
            console.error('❌ Leave error:', err);
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log('🔌 Player disconnected:', socket.id);

        if (socket.roomId && socket.playerNumber) {
            const room = gameRooms[socket.roomId];
            if (room && room.players[socket.playerNumber]) {
                delete room.players[socket.playerNumber];
                io.to(socket.roomId).emit('playerLeft', { playerNumber: socket.playerNumber });

                if (Object.keys(room.players).length === 0) {
                    delete gameRooms[socket.roomId];
                }
            }
        }
    });
});

// REST API Endpoints
app.get('/api/rooms', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM game_rooms WHERE status = $1', ['waiting']);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT player_number, SUM(score) as total_score, COUNT(*) as games_played
            FROM players
            WHERE finished = true
            GROUP BY player_number
            ORDER BY total_score DESC
            LIMIT 10
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;

initDB().then(() => {
    httpServer.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
});
