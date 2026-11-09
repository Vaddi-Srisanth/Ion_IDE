"""Speak bounded newline JSON with Ion and Jupyter's local kernel protocol."""

import json
import os
import queue
import secrets
import signal
import subprocess
import sys
import threading
import time


KERNEL_BOOT = """
import os, sys
from ipykernel.kernelapp import IPKernelApp
connection, directory = sys.argv[1:3]
sys.path[:] = [entry for entry in sys.path if entry and os.path.abspath(entry) != os.getcwd()]
os.chdir(directory)
sys.argv[:] = ['ipykernel', '-f', connection]
IPKernelApp.launch_instance()
"""

TEXT_LIMIT = 256 * 1024
IMAGE_LIMIT = 4 * 1024 * 1024
OUTPUT_LIMIT = 8 * 1024 * 1024
OUTPUT_COUNT = 160


def emit(kind, **fields):
    line = json.dumps({'type': kind, **fields}, ensure_ascii=True, separators=(',', ':'))
    sys.stdout.write(line + '\n')
    sys.stdout.flush()
    return len(line)


def text(value, limit=TEXT_LIMIT):
    return value[:limit] if isinstance(value, str) else ''


def output_for(kind, content):
    if kind == 'stream':
        return {'output_type': 'stream', 'name': 'stderr' if content.get('name') == 'stderr' else 'stdout',
                'text': text(content.get('text'))}
    if kind == 'error':
        frames = content.get('traceback')
        return {'output_type': 'error', 'ename': text(content.get('ename'), 250),
                'evalue': text(content.get('evalue'), 8 * 1024),
                'traceback': [text(line, 8 * 1024) for line in frames[:48]] if isinstance(frames, list) else []}
    if kind == 'clear_output':
        return {'output_type': 'ion-clear-output'}
    if kind not in ('display_data', 'execute_result', 'update_display_data'):
        return None
    data = content.get('data')
    if not isinstance(data, dict):
        return None
    selected = {}
    for mime in ('text/plain', 'text/html', 'image/png', 'image/jpeg', 'image/svg+xml'):
        value = data.get(mime)
        if isinstance(value, str):
            if mime.startswith('text/'):
                selected[mime] = text(value)
            elif len(value) <= IMAGE_LIMIT:
                selected[mime] = value
    if not selected:
        selected['text/plain'] = 'This output is too large or uses a format Ion cannot display.'
    result = {'output_type': 'execute_result' if kind == 'execute_result' else 'display_data',
              'data': selected, 'metadata': {}}
    if kind == 'execute_result':
        count = content.get('execution_count')
        result['execution_count'] = count if isinstance(count, int) and count >= 0 else None
    return result


def signal_kernel(process, sig):
    try:
        if process.poll() is None:
            process.send_signal(sig)
    except ProcessLookupError:
        pass


def read_commands(process, commands, stop, interrupted):
    pending = b''
    try:
        while chunk := os.read(0, 65536):
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                if len(line) > 2 * 1024 * 1024:
                    return
                command = json.loads(line)
                op = command.get('op')
                if op == 'stop':
                    return
                if op == 'interrupt':
                    interrupted.set()
                    signal_kernel(process, signal.SIGINT)
                elif op == 'run':
                    interrupted.clear()
                    commands.put_nowait(command)
            if len(pending) > 2 * 1024 * 1024:
                return
    except (OSError, ValueError, AttributeError, queue.Full):
        pass
    finally:
        stop.set()
        signal_kernel(process, signal.SIGINT)
        try:
            commands.put_nowait(None)
        except queue.Full:
            pass


def run_cell(client, process, command, stop, interrupted):
    identifier, code = command['id'], command['code']
    if interrupted.is_set():
        emit('done', id=identifier, count=None, status='interrupted')
        return
    parent = client.execute(code, allow_stdin=False, stop_on_error=True)
    deadline = time.monotonic() + 120
    emitted = 0
    used = 0
    truncated = False
    deferred_clear = False
    while not stop.is_set():
        if process.poll() is not None:
            raise RuntimeError('The Python kernel exited during execution.')
        if time.monotonic() > deadline:
            signal_kernel(process, signal.SIGINT)
            raise RuntimeError('The notebook cell exceeded its two-minute execution limit.')
        try:
            message = client.get_iopub_msg(timeout=0.25)
        except queue.Empty:
            continue
        if message['parent_header'].get('msg_id') != parent:
            continue
        kind, content = message['msg_type'], message['content']
        if kind == 'status' and content.get('execution_state') == 'idle':
            break
        if kind == 'clear_output' and content.get('wait'):
            deferred_clear = True
            continue
        output = output_for(kind, content)
        if output is None:
            continue
        cost = len(json.dumps(output, ensure_ascii=True, separators=(',', ':')))
        if emitted < OUTPUT_COUNT and used + cost <= OUTPUT_LIMIT:
            if deferred_clear and output['output_type'] != 'ion-clear-output':
                used += emit('output', id=identifier, output={'output_type': 'ion-clear-output'})
                emitted += 1
            deferred_clear = False
            used += emit('output', id=identifier, output=output)
            emitted += 1
        elif not truncated:
            truncated = True
            emit('output', id=identifier, output={'output_type': 'stream', 'name': 'stderr',
                 'text': '\nIon omitted additional output after the preview limit.\n'})
    if stop.is_set():
        return
    reply_deadline = time.monotonic() + 3
    while time.monotonic() < reply_deadline and not stop.is_set():
        try:
            reply = client.get_shell_msg(timeout=0.25)
        except queue.Empty:
            continue
        if reply['parent_header'].get('msg_id') == parent:
            content = reply['content']
            count = content.get('execution_count')
            state = 'interrupted' if interrupted.is_set() else 'ok' if content.get('status') == 'ok' else 'error'
            emit('done', id=identifier, count=count if isinstance(count, int) and count >= 0 else None, status=state)
            return
    if not stop.is_set():
        raise RuntimeError('The Python kernel did not finish its execution reply.')


def main():
    import zmq
    from jupyter_client import BlockingKernelClient, write_connection_file

    scratch = os.getcwd()
    connection = os.path.join(scratch, 'connection.json')
    write_connection_file(connection, ip='127.0.0.1', key=secrets.token_hex(32).encode('ascii'))
    context = zmq.Context()
    context.setsockopt(zmq.MAXMSGSIZE, 24 * 1024 * 1024)
    client = BlockingKernelClient(context=context)
    client.load_connection_file(connection)
    environment = dict(os.environ, IPYTHONDIR=os.path.join(scratch, 'ipython'),
                       JUPYTER_CONFIG_DIR=os.path.join(scratch, 'config'),
                       JUPYTER_RUNTIME_DIR=os.path.join(scratch, 'runtime'))
    process = subprocess.Popen([sys.executable, '-E', '-c', KERNEL_BOOT, connection, sys.argv[1]],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               env=environment)
    stop, interrupted = threading.Event(), threading.Event()
    commands = queue.Queue(maxsize=1)
    threading.Thread(target=read_commands, args=(process, commands, stop, interrupted), daemon=True).start()
    try:
        client.start_channels(stdin=False, control=False)
        client.wait_for_ready(timeout=12)
        emit('ready')
        while not stop.is_set():
            command = commands.get()
            if command is None:
                break
            run_cell(client, process, command, stop, interrupted)
    finally:
        client.stop_channels()
        context.destroy(linger=0)
        signal_kernel(process, signal.SIGTERM)
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            signal_kernel(process, signal.SIGKILL)
            process.wait(timeout=1)


if __name__ == '__main__':
    try:
        main()
    except ImportError:
        emit('failure', message='This Python environment needs locally installed jupyter_client and ipykernel.')
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        emit('failure', message=text(str(error), 400) or 'The local Python kernel failed.')
