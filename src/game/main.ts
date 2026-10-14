import { GAME_HEIGHT, GAME_WIDTH } from "../constants";
import { Game as MainGame } from "./scenes/Game";
import { AUTO, Game, Scale, Types } from "phaser";
import type { GameSettings } from "../main";

// Find out more information about the Game Config at:
// https://docs.phaser.io/api-documentation/typedef/types-core#gameconfig
const config: Types.Core.GameConfig = {
  type: AUTO,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  parent: "game-container",
  backgroundColor: "#ffffdd",
  scale: {
    mode: Scale.FIT,
    autoCenter: Scale.CENTER_BOTH,
  },
  scene: [MainGame],
};

const StartGame = (parent: string, settings: GameSettings) => {
  MainGame.initialSettings = settings;
  return new Game({ ...config, parent, callbacks: {
    preBoot: (game) => game.registry.set("settings", settings),
  } });
};

export default StartGame;
