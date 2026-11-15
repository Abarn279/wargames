import { Game } from './ui/game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas);
(window as unknown as { game: Game }).game = game; // handy for debugging / automated checks
game.start();
