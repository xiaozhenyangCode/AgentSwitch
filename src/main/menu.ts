import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC, type MenuCommand } from '@shared/types'
import { t } from './i18n'

/**
 * Native menu bar, localized. App-level commands (about / settings / new chat / search) are sent
 * to the renderer, which owns navigation; everything else uses Electron's built-in roles.
 */
export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const send = (cmd: MenuCommand) => () => {
    const w = getWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.webContents.send(IPC.menuCommand, cmd)
  }
  const dev = !app.isPackaged

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: t('menu.about'), click: send('about') },
        { type: 'separator' },
        { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        { label: t('menu.services'), role: 'services' },
        { type: 'separator' },
        { label: t('menu.hide'), role: 'hide' },
        { label: t('menu.hideOthers'), role: 'hideOthers' },
        { label: t('menu.showAll'), role: 'unhide' },
        { type: 'separator' },
        { label: t('menu.quit'), role: 'quit' }
      ]
    },
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.newChat'), accelerator: 'CmdOrCtrl+N', click: send('newThread') },
        { type: 'separator' },
        { label: t('menu.closeWindow'), role: 'close' }
      ]
    },
    {
      label: t('menu.edit'),
      submenu: [
        { label: t('menu.undo'), role: 'undo' },
        { label: t('menu.redo'), role: 'redo' },
        { type: 'separator' },
        { label: t('menu.cut'), role: 'cut' },
        { label: t('menu.copy'), role: 'copy' },
        { label: t('menu.paste'), role: 'paste' },
        { label: t('menu.selectAll'), role: 'selectAll' }
      ]
    },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.searchChats'), accelerator: 'CmdOrCtrl+K', click: send('search') },
        { type: 'separator' },
        { label: t('menu.reload'), role: 'reload' },
        { label: t('menu.devtools'), role: 'toggleDevTools', visible: dev },
        { type: 'separator' },
        { label: t('menu.actualSize'), role: 'resetZoom' },
        { label: t('menu.zoomIn'), role: 'zoomIn' },
        { label: t('menu.zoomOut'), role: 'zoomOut' },
        { type: 'separator' },
        { label: t('menu.fullscreen'), role: 'togglefullscreen' }
      ]
    },
    {
      label: t('menu.window'),
      role: 'windowMenu',
      submenu: [
        { label: t('menu.minimize'), role: 'minimize' },
        { label: t('menu.zoom'), role: 'zoom' },
        { type: 'separator' },
        { label: t('menu.front'), role: 'front' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
