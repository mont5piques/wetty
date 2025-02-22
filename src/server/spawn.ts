import isUndefined from 'lodash/isUndefined.js';
import pty from 'node-pty';
import { logger as getLogger } from '../shared/logger.js';
import { tinybuffer, FlowControlServer } from './flowcontrol.js';
import { xterm } from './shared/xterm.js';
import { envVersionOr } from './spawn/env.js';
import type SocketIO from 'socket.io';

export async function spawn(
  socket: SocketIO.Socket,
  args: string[],
  customEnv: object,
): Promise<void> {
  const logger = getLogger();
  const version = await envVersionOr(0);
  const cmd = version >= 9 ? ['-S', ...args] : args;
  const spawnXterm = Object.assign({}, xterm);
  spawnXterm.env = Object.assign(customEnv, ...Object.keys(process.env)
    .filter((key) => !isUndefined(process.env[key]))
    .map((key) => ({ [key]: process.env[key] })));
  logger.debug('Spawning PTY', { cmd });
  const term = pty.spawn('/usr/bin/env', cmd, spawnXterm);
  const { pid } = term;
  const address = args[0] === 'ssh' ? args[1] : 'localhost';
  logger.info('Process Started on behalf of user', { pid, address });
  socket.emit('login');
  term.on('exit', (code: number) => {
    logger.info('Process exited', { code, pid });
    socket.emit('logout');
    socket
      .removeAllListeners('disconnect')
      .removeAllListeners('resize')
      .removeAllListeners('input');
  });
  const send = tinybuffer(socket, 2, 524288);
  const fcServer = new FlowControlServer();
  term.on('data', (data: string) => {
    send(data);
    if (fcServer.account(data.length)) {
      term.pause();
    }
  });
  socket
    .on('resize', ({ cols, rows }) => {
      term.resize(cols, rows);
    })
    .on('input', input => {
      if (!isUndefined(term)) term.write(input);
    })
    .on('disconnect', () => {
      term.kill();
      logger.info('Process exited', { code: 0, pid });
    })
    .on('commit', size => {
      if (fcServer.commit(size)) {
        term.resume();
      }
    });
}
