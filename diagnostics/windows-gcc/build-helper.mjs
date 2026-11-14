import {buildWindowsPty} from './scripts/windows/build-pty.mjs';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Native Windows x64 required.');
const scratch=resolve('build-temp');await mkdir(scratch,{recursive:true});process.env.TEMP=scratch;process.env.TMP=scratch;
await buildWindowsPty(resolve('native/ion-pty.exe'),'x64',resolve('src/main/run-console/pty-windows.cpp'));
