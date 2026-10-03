import { mount } from '../ui/app.js';

// Same app as the popup, at panel density — this is the surface meant to stay
// pinned beside your work so neither stream drops out of view.
mount(document.getElementById('root'), 'panel');
