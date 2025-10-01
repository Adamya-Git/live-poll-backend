// server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 4000;

const polls = {}; // pollId -> {title, students: {}, current, history: []}

function makeId() {
  return Math.random().toString(36).slice(2, 9);
}

function computeResults(current) {
  const counts = current.options.map(() => 0);
  Object.values(current.answers || {}).forEach(idx => {
    if (typeof idx === 'number' && counts[idx] !== undefined) counts[idx]++;
  });
  return { counts, total: Object.keys(current.answers || {}).length };
}

app.get('/', (req, res) => res.send('Live Poll Server Running'));

io.on('connection', socket => {
  console.log('Socket connected', socket.id);

  // Teacher creates poll
  socket.on('teacher:create-poll', ({ title }, cb) => {
    const pollId = makeId();
    polls[pollId] = { 
      title: title || 'Untitled Poll', 
      students: {}, 
      current: null, 
      history: [] 
    };

    // teacher joins poll room
    socket.join(pollId);

    cb && cb({ ok: true, pollId });
    console.log('Poll created:', pollId);
  });

  // Teacher starts question
  socket.on('teacher:start-question', ({ pollId, question, options, duration=60, correctIndex }, cb) => {
    if (!polls[pollId]) return cb && cb({ ok:false, error:'Poll not found' });
    if (polls[pollId].current) return cb && cb({ ok:false, error:'Question already active' });

    const current = {
      id: makeId(),
      question,
      options,
      answers: {},
      duration,
      endsAt: Date.now() + duration * 1000,
      correctIndex
    };
    polls[pollId].current = current;

    // broadcast question to all students & teacher
    io.to(pollId).emit('question:start', { 
      question: current.question, 
      options: current.options, 
      endsAt: current.endsAt 
    });

    // timer
    const timeout = setTimeout(() => {
      const res = computeResults(polls[pollId].current);
      io.to(pollId).emit('question:end', { 
        results: res, 
        correctIndex: current.correctIndex, 
        options: current.options 
      });
      polls[pollId].history.push({ ...current, results: res });
      polls[pollId].current = null;
    }, duration * 1000);

    polls[pollId].timeout = timeout;
    cb && cb({ ok:true });
  });

  // Student joins poll
  socket.on('student:join', ({ pollId, name }, cb) => {
    if (!polls[pollId]) return cb && cb({ ok:false, error:'Poll not found' });

    polls[pollId].students[socket.id] = name || 'Anonymous';
    socket.join(pollId);

    // update teacher & everyone in room
    io.to(pollId).emit('student:list', Object.values(polls[pollId].students));

    cb && cb({ ok:true });
  });

  // Student answers
  socket.on('student:answer', ({ pollId, optionIndex }, cb) => {
    const poll = polls[pollId];
    if (!poll || !poll.current) return cb && cb({ ok:false, error:'No active question' });

    poll.current.answers[socket.id] = optionIndex;

    const partial = computeResults(poll.current);
    io.to(pollId).emit('question:partial', { partial });

    // if all students answered, end early
    const totalStudents = Object.keys(poll.students).length;
    const answered = Object.keys(poll.current.answers).length;
    if (totalStudents > 0 && answered >= totalStudents) {
      clearTimeout(poll.timeout);
      const res = computeResults(poll.current);
      io.to(pollId).emit('question:end', { 
        results: res, 
        correctIndex: poll.current.correctIndex, 
        options: poll.current.options 
      });
      poll.history.push({ ...poll.current, results: res });
      poll.current = null;
    }
    cb && cb({ ok:true });
  });

  // Disconnect cleanup
  socket.on('disconnect', () => {
    for (const [pid, poll] of Object.entries(polls)) {
      if (poll.students[socket.id]) {
        delete poll.students[socket.id];
        io.to(pid).emit('student:list', Object.values(poll.students));
      }
    }
    console.log('Socket disconnected', socket.id);
  });
});

server.listen(PORT, () => console.log('Server running on port', PORT));


