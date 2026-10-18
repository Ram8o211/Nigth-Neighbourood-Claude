import './ui/style.css';
import { runViewer } from './viewer';
import { Game } from './game/game';
import { UI } from './ui/ui';
import { installTestApi } from './game/testapi';

const params = new URLSearchParams(location.search);
// iOS ignores user-scalable=no; a pinch would zoom the whole game
document.addEventListener('gesturestart', (e) => e.preventDefault());
if (params.has('viewer')) {
  runViewer(params);
} else {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const root = document.getElementById('ui') as HTMLDivElement;
  try {
    const game = new Game(canvas);
    const ui = new UI(game);
    game.attachUI(ui);
    game.start();
    (window as unknown as { __game: Game }).__game = game;
    installTestApi(game);
  } catch (err) {
    console.error(err);
    // the start-up check in index.html leaves this explanation alone
    (window as unknown as { __bootFailed: boolean }).__bootFailed = true;
    root.innerHTML = `<div class="screen error-screen"><h1>Night Neighbour could not start</h1><p>${String((err as Error)?.message ?? err)}</p><p>A browser with WebGL2 support is required.</p></div>`;
  }
}
