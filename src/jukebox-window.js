'use strict';
// The Jukebox in a window of its own is this same page, opened with ?window=jukebox: the launcher's frame, tabs and other pages are hidden by the
// class this sets (style.css), before anything is drawn, and jukebox-page.js shows the Jukebox.
if (new URLSearchParams(location.search).get('window') === 'jukebox') document.documentElement.classList.add('jukebox-window');
