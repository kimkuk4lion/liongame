import { io, Socket } from "socket.io-client";
import { Scene } from "phaser";
import { MOVE_DURATION, MOVE_RANDOM } from "../../constants";
import type { GameSettings } from "../../main";
import { Marble, RenderArgs, System } from "../../system";

export class Game extends Scene {
  static initialSettings?: GameSettings;
  private settings!: GameSettings;
  private socket?: Socket;
  private system?: System;

  constructor() {
    super("Game");
  }

  preload() {
    this.load.setPath("assets");
    this.load.image("marble_red", "marble_red.png");
    this.load.image("marble_green", "marble_green.png");
    this.load.image("hole", "hole.png");
    this.load.image("cursor", "cursor.png");
  }

  init(data: GameSettings) {
    this.settings = data?.playerCount ? data : Game.initialSettings ?? {
      mode: "practice",
      playerCount: 4,
      names: ["연습 1", "연습 2", "연습 3", "연습 4"],
      serverUrl: "",
    };
  }

  create() {
    const marbleImages: Phaser.GameObjects.Image[] = [];
    const labels: Phaser.GameObjects.Text[] = [];
    const description = this.add.text(18, 18, "", {
      color: "#241b12",
      fontSize: 22,
      fontStyle: "bold",
      backgroundColor: "#ffffffcc",
      padding: { x: 10, y: 8 },
    }).setDepth(10);
    const powerText = this.add.text(18, 86, "힘: 0%", {
      color: "#241b12",
      fontSize: 18,
      backgroundColor: "#ffffffcc",
      padding: { x: 8, y: 5 },
    }).setDepth(10);
    const guideLine = this.add.line(0, 0, 0, 0, 0, 0, 0xff0000, 0.3)
      .setDepth(3).setLineWidth(20, 1);
    const cursor = this.add.circle(-9999, 0, MOVE_RANDOM, 0x0000ff, 0.2).setDepth(-1);
    const system = new System(this.settings.playerCount, (args) =>
      this.render(args, marbleImages, labels, description, guideLine, powerText)
    , this.settings.names);
    this.system = system;

    const onRemoteMove = (move: { playerId: number; x: number; y: number }) => {
      if (move.playerId !== system.getSnapshot().turn) return;
      system.moveMarble(move.x, move.y, move.playerId, false);
    };
    if (this.settings.mode === "multi") {
      this.socket = io(this.settings.serverUrl);
      this.socket.on("game:move", onRemoteMove);
      this.socket.on("game:error", (message: string) => description.setText(message));
    }

    system.render();
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      const current = system.getSnapshot().marbles[system.getSnapshot().turn];
      const power = Math.min(100, Math.round(Math.hypot(pointer.x - current.x, pointer.y - current.y) / 2));
      powerText.setText(`힘: ${power}%`);
      const move = system.moveMarble(pointer.x, pointer.y);
      if (!move) return;
      cursor.setPosition(pointer.x, pointer.y);
      this.time.delayedCall(MOVE_DURATION, () => cursor.setPosition(-9999, 0));
      this.socket?.emit("game:move", { roomId: this.settings.roomId, ...move });
    });
  }

  shutdown() {
    this.system?.destroy();
    this.socket?.disconnect();
  }

  private render(
    args: RenderArgs,
    marbleImages: Phaser.GameObjects.Image[],
    labels: Phaser.GameObjects.Text[],
    description: Phaser.GameObjects.Text,
    guideLine: Phaser.GameObjects.Line,
    powerText: Phaser.GameObjects.Text
  ) {
    if (marbleImages.length === 0) {
      args.marbles.forEach((marble) => {
        marbleImages.push(this.add.image(0, 0, "marble_green").setDepth(1));
        labels.push(this.add.text(0, 0, "", {
          color: "#111",
          fontSize: 12,
          fontStyle: "bold",
          align: "center",
          backgroundColor: "#ffffffbb",
          padding: { x: 3, y: 2 },
        }).setOrigin(0.5, 1).setDepth(2));
      });
      args.holes.forEach((hole) => this.add.image(hole.x, hole.y, "hole"));
    }

    const current = args.marbles[args.turn];
    const currentPower = current
      ? Math.min(100, Math.round(Math.hypot(this.input.activePointer.x - current.x, this.input.activePointer.y - current.y) / 2))
      : 0;
    powerText.setText(`힘: ${currentPower}%`);
    description.setText(
      args.winner
        ? `${args.winner.name}님이 우승하였습니다!\n클릭하면 스코어보드를 확인합니다.`
        : `${current.name}님의 차례  ·  ${args.remainingSeconds}초\n구멍 +2  구슬 +1  구멍 밖으로 +3  사자 처치 +2`
    );
    args.marbles.forEach((marble, i) => {
      const image = marbleImages[i];
      const label = labels[i];
      image.setPosition(marble.x, marble.y).setTexture(marble.lion ? "marble_red" : "marble_green");
      image.setAlpha(marble.alive ? 1 : 0);
      label.setPosition(marble.x, marble.y - 18).setText(`${marble.name} · ${marble.score}`);
      label.setAlpha(marble.alive ? (i === args.turn ? 1 : 0.65) : 0);
      if (i === args.turn && marble.alive && args.state !== "finished") {
        const hole = args.holes[marble.hole];
        guideLine.setTo(marble.x, marble.y, hole.x, hole.y).setAlpha(1);
      }
    });

    if (args.winner) {
      this.input.once("pointerdown", () => this.showScoreboard(args.marbles));
    }
  }

  private showScoreboard(marbles: Marble[]) {
    const board = marbles
      .filter((marble) => marble.alive || marble.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((marble, index) => `${index + 1}. ${marble.name}  ${marble.score}점`)
      .join("\n");
    this.add.text(300, 650, `스코어보드\n\n${board}`, {
      color: "#25170d",
      fontSize: 28,
      align: "center",
      backgroundColor: "#fffbeeee",
      padding: { x: 24, y: 20 },
    }).setOrigin(0.5).setDepth(20);
  }
}
