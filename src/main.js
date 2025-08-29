import './styles.css';
import { initGallery3D } from './gallery3d.js';

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await initGallery3D('#webgl');
  } catch (err) {
    console.error('Init error:', err);
    alert('Si è verificato un problema nel caricamento della galleria 3D.');
  }
});
