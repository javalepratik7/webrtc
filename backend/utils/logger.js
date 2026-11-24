// Tiny console logger with timestamps and levels.
// Signaling bugs are all about ORDER of events (offer before answer, candidates
// arriving early...), so every log line carries a precise timestamp.

const COLORS = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };

function write(level, args) {
  const time = new Date().toISOString();
  const tag = `${COLORS[level]}[${level.toUpperCase()}]${COLORS.reset}`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  out(`${time} ${tag}`, ...args);
}

const logger = {
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
};

export default logger;
