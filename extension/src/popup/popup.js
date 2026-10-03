import { mount } from '../ui/app.js';

// The toolbar icon and Ctrl+Shift+K both land here; mount() focuses the
// composer so a captured thought takes one keystroke and a sentence.
mount(document.getElementById('root'), 'popup');
