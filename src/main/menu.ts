import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../shared/contracts'
import { commandLabel, effectiveShortcut, menuAccelerator, shortcutPlatform, type ShortcutOverrides } from '../shared/shortcuts'

export function installMenu(send: (command: MenuCommand) => void, shortcuts: ShortcutOverrides): void {
  const mac = process.platform === 'darwin'
  const platform = shortcutPlatform(process.platform)
  const command = (id: MenuCommand): MenuItemConstructorOptions => ({
    label: commandLabel(id), accelerator: menuAccelerator(effectiveShortcut(id, shortcuts, platform)), click: () => send(id),
  })
  const settings = command('settings')
  const template: MenuItemConstructorOptions[] = []
  if (mac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' }, settings, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
      ],
    })
  }
  template.push(
    {
      label: 'File',
      submenu: [
        command('new-file'), command('new-starter'), command('quick-open'), command('open-file'), command('open-folder'),
        { type: 'separator' },
        command('save'), command('save-as'), command('close-tab'),
        ...(mac ? [] : [{ type: 'separator' } as const, settings]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' },
        command('find'), command('replace'), command('workspace-search'), command('go-to-line'), command('insert-starter'),
      ],
    },
    {
      label: 'View',
      submenu: [
        command('command-palette'), command('welcome'), command('focus-editor'),
        command('next-tab'), command('previous-tab'),
        { type: 'separator' },
        command('toggle-explorer'), command('toggle-marketplace'), command('toggle-output'), command('toggle-auxiliary'),
        command('toggle-document-split'), command('focus-document-split'),
        command('markdown-preview'), command('markdown-split'),
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Run',
      submenu: [command('run'), command('stop'), command('preview-web')],
    },
    { role: 'windowMenu' },
  )
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
