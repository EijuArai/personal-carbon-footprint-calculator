import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Configure the transport to use pino-pretty
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,                  // Adds colors to the terminal output
      translateTime: 'SYS:standard',   // Formats the timestamp to a readable standard
      ignore: 'pid,hostname',          // Hides the process ID and hostname
      singleLine: true                 // Prints each log message on a single line
    }
  }
});

export default logger;