'use strict';

// Where her window goes on a screen ({ bounds, workArea }, in DIP), for where she rests ('corner' or
// 'taskbar'). `gap`: how much of her window is below the bottom of the work area (0, or the height
// of the taskbar), where her legs hang while she sits on it.
//
// Windows: the work area, or the whole screen while she rests on the taskbar, less its top row of
// pixels: a window on top covering the whole screen is a fullscreen app to Windows (animated
// wallpapers pause, notifications wait).
// macOS: always the work area (never over the menu bar nor the Dock). Resting on the Dock, she stands
// on it while it shows: all of her stays in sight.
function overlayArea({ bounds, workArea }, rest, platform = process.platform) {
  const area = rest === 'taskbar' && platform !== 'darwin' ? { ...bounds, y: bounds.y + 1, height: bounds.height - 1 } : workArea;
  return { area, gap: area.y + area.height - (workArea.y + workArea.height) };
}

module.exports = { overlayArea };
