"""Portable broker contract checks; actual Windows Jupyter runs are separate."""
import runpy
import signal
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class InterruptContract(unittest.TestCase):
    def setUp(self):
        self.broker = runpy.run_path(str(Path(__file__).resolve().parents[1]
                                        / 'src/main/notebooks/kernel-broker.py'))

    def test_windows_interrupt_uses_jupyter_event_not_unsupported_posix_signal(self):
        process = Mock(win32_interrupt_event=123)
        process.poll.return_value = None
        process.send_signal.side_effect = OSError('SIGINT is not a Windows Popen signal')
        event = Mock()
        module = types.ModuleType('jupyter_client.win_interrupt')
        module.send_interrupt = event
        with patch.object(sys, 'platform', 'win32'), patch.dict(sys.modules,
                {'jupyter_client.win_interrupt': module}):
            self.broker['signal_kernel'](process, signal.SIGINT)
        event.assert_called_once_with(123)
        process.send_signal.assert_not_called()

    def test_posix_interrupt_retains_existing_signal(self):
        process = Mock()
        process.poll.return_value = None
        with patch.object(sys, 'platform', 'darwin'):
            self.broker['signal_kernel'](process, signal.SIGINT)
        process.send_signal.assert_called_once_with(signal.SIGINT)

    def test_finished_kernel_is_never_signaled(self):
        process = Mock()
        process.poll.return_value = 0
        self.broker['signal_kernel'](process, signal.SIGINT)
        process.send_signal.assert_not_called()

    def test_owned_windows_handles_close_even_if_first_close_fails(self):
        process = Mock(win32_interrupt_event=123)
        closed = Mock(side_effect=[OSError('first close failed'), None])
        module = types.ModuleType('_winapi')
        module.CloseHandle = closed
        with patch.dict(sys.modules, {'_winapi': module}):
            with self.assertRaisesRegex(OSError, 'first close failed'):
                self.broker['close_windows_kernel_handles'](process, {'JPY_PARENT_PID': '456'})
        self.assertEqual([call.args[0] for call in closed.call_args_list], [123, 456])


if __name__ == '__main__':
    unittest.main()
