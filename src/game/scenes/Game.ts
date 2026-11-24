import type { Socket } from "socket.io-client";
import { Scene } from "phaser";
import { AIM_SENSITIVITY, GAME_HEIGHT, GAME_WIDTH, TURN_SECONDS } from "../../constants";
import type { GameSettings } from "../../main";
import { Marble, RenderArgs, System } from "../../system";

export class Game extends Scene {
  static initialSettings?: GameSettings;
  private settings!: GameSettings;
  private socket?: Socket;
  private system?: System;
  private dragging = false;
  private aimTurn = -1;
  private requestSequence = 0;
  private latestVersion = 0;
  private aborted = false;
  private abortTimer: number | undefined;
  private readonly cleanup: (() => void)[] = [];

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
    this.settings = data?.playerCount
      ? data
      : (Game.initialSettings ?? {
          mode: "practice",
          playerCount: 4,
          names: ["연습 1", "연습 2", "연습 3", "연습 4"],
          serverUrl: "",
        });
  }

  create() {
    const marbleImages: Phaser.GameObjects.Image[] = [];
    const labels: Phaser.GameObjects.Text[] = [];
    const description = this.add
      .text(18, 18, "", {
        color: "#f7f1df",
        fontSize: 22,
        fontStyle: "bold",
        backgroundColor: "#192c25",
        padding: { x: 10, y: 8 },
      })
      .setDepth(10);
    const powerText = this.add
      .text(18, 86, "", {
        color: "#f1cc83",
        fontSize: 18,
        backgroundColor: "#192c25",
        padding: { x: 8, y: 5 },
      })
      .setDepth(10)
      .setVisible(false);
    const backButton = this.add.container(516, 38).setDepth(20);
    const backBackground = this.add
      .rectangle(0, 0, 140, 46, 0xf1cc83, 1)
      .setStrokeStyle(2, 0x78663f)
      .setInteractive({ useHandCursor: true });
    const backLabel = this.add
      .text(0, 0, "메인으로", {
        color: "#1c251d",
        fontSize: 18,
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    backButton.add([backBackground, backLabel]);
    backBackground.on("pointerdown", () => {
      if (
        this.settings.mode === "practice" ||
        this.system?.getSnapshot().state === "finished" ||
        window.confirm("게임을 나가면 현재 플레이어는 탈락 처리됩니다. 메인으로 이동할까요?")
      )
        this.settings.onExit?.();
    });
    const guideLine = this.add
      .line(0, 0, 0, 0, 0, 0, 0xff0000, 0.3)
      .setDepth(3)
      .setLineWidth(20, 1);
    const aimLine = this.add
      .line(0, 0, 0, 0, 0, 0x1d70ff, 0.8)
      .setDepth(4)
      .setLineWidth(6, 1)
      .setVisible(false);
    const pullLine = this.add
      .line(0, 0, 0, 0, 0, 0xff9f1c, 0.8)
      .setDepth(4)
      .setLineWidth(4, 1)
      .setVisible(false);
    const trajectory = this.add.graphics().setDepth(4).setVisible(false);
    const playerIds =
      this.settings.playerIds ??
      Array.from({ length: this.settings.playerCount }, (_, index) => index);
    const system = new System(
      playerIds,
      (args) => {
        if (this.dragging && (args.turn !== this.aimTurn || args.state !== "wait_move" || args.remainingSeconds === 0))
          this.cancelAim(aimLine, pullLine, trajectory, powerText);
        this.render(args, marbleImages, labels, description, guideLine);
      },
      this.settings.names,
      Boolean(this.settings.socket),
      (x, y) => this.showLionHit(x, y),
      TURN_SECONDS[this.settings.difficulty ?? "normal"],
    );
    this.system = system;
    if (this.settings.socket && this.settings.initialState) {
      const initialState = this.settings.initialState as Parameters<System["applyServerState"]>[0];
      this.latestVersion = Math.max(this.latestVersion, initialState.version ?? 0);
      system.applyServerState(initialState);
    }

    const onState = (state: {
      version: number;
      gameId: number;
      turnId: number;
      turnPlayerId: number;
      deadline: number;
      pausedRemainingMs?: number;
      state: "wait_move" | "moving" | "paused" | "finished";
      marbles: Marble[];
      winnerId?: number;
    }) => {
      if (state.gameId !== this.settings.gameId || state.version <= this.latestVersion) return;
      this.latestVersion = state.version;
      this.settings.turnId = state.turnId;
      this.cancelAim(aimLine, pullLine, trajectory, powerText);
      system.applyServerState(state);
    };
    if (this.settings.socket) {
      this.socket = this.settings.socket;
      const onLionHit = (hit: { gameId: number; x: number; y: number }) => {
        if (hit.gameId === this.settings.gameId) this.showLionHit(hit.x, hit.y);
      };
      this.socket.on("game:lion-hit", onLionHit);
      this.cleanup.push(() => this.socket?.off("game:lion-hit", onLionHit));
      this.socket.on("game:state", onState);
      this.cleanup.push(() => this.socket?.off("game:state", onState));
      const onError = (message: string) => {
        if (system.getSnapshot().state === "finished") return;
        description.setText(message);
        system.applyServerState({
          version: this.latestVersion + 1,
          gameId: this.settings.gameId ?? 0,
          turnId: this.settings.turnId ?? 0,
          turnPlayerId: system.getSnapshot().turn,
          deadline: Date.now(),
          state: "wait_move",
          marbles: system.getSnapshot().marbles,
        });
      };
      this.socket.on("game:error", onError);
      this.cleanup.push(() => this.socket?.off("game:error", onError));
      const onTurn = (turn: { playerId: number; turnId: number; deadline: number }) => {
        this.settings.turnId = turn.turnId;
        this.cancelAim(aimLine, pullLine, trajectory, powerText);
        system.syncTurn(turn.playerId, Math.max(0, turn.deadline - Date.now()));
      };
      this.socket.on("game:turn", onTurn);
      this.cleanup.push(() => this.socket?.off("game:turn", onTurn));
      const onDisconnected = (data: { playerId: number; graceMs: number }) => {
        const player = system.getSnapshot().marbles.find((marble) => marble.id === data.playerId);
        description.setText(
          `${player?.name ?? `플레이어 ${data.playerId + 1}`}의 연결이 끊겼습니다. 재접속을 기다리는 중입니다. (30초)`,
        );
        this.cancelAim(aimLine, pullLine, trajectory, powerText);
      };
      const onReconnected = (data: { playerId: number }) => {
        const player = system.getSnapshot().marbles.find((marble) => marble.id === data.playerId);
        description.setText(
          `${player?.name ?? `플레이어 ${data.playerId + 1}`}가 다시 접속했습니다. 게임을 재개합니다.`,
        );
      };
      const onEliminated = (data: { playerId: number; reason: string }) => {
        const player = system.getSnapshot().marbles.find((marble) => marble.id === data.playerId);
        const reasonText =
          data.reason === "manual_leave"
            ? "게임에서 나가 탈락했습니다."
            : "복귀 시간이 만료되어 탈락했습니다.";
        description.setText(`${player?.name ?? `플레이어 ${data.playerId + 1}`}가 ${reasonText}`);
      };
      const onPaused = () => {
        this.cancelAim(aimLine, pullLine, trajectory, powerText);
        description.setText("연결이 끊긴 플레이어를 기다리는 중입니다. 게임이 일시정지되었습니다.");
      };
      const onResumed = () =>
        description.setText("플레이어가 다시 접속했습니다. 게임을 재개합니다.");
      this.socket.on("player:disconnected", onDisconnected);
      this.socket.on("player:reconnected", onReconnected);
      this.socket.on("player:eliminated", onEliminated);
      this.socket.on("game:paused", onPaused);
      this.socket.on("game:resumed", onResumed);
      this.cleanup.push(
        () => this.socket?.off("player:disconnected", onDisconnected),
        () => this.socket?.off("player:reconnected", onReconnected),
        () => this.socket?.off("player:eliminated", onEliminated),
        () => this.socket?.off("game:paused", onPaused),
        () => this.socket?.off("game:resumed", onResumed),
      );
      const onAborted = (data: { message: string }) => {
        if (this.aborted) return;
        this.aborted = true;
        description.setText(data.message);
        this.cleanupAim(aimLine, pullLine, trajectory, powerText);
        this.abortTimer = window.setTimeout(() => this.settings.onAbort?.(), 800);
      };
      this.socket.on("game:aborted", onAborted);
      this.cleanup.push(() => this.socket?.off("game:aborted", onAborted));
    }

    system.render();
    const updateAim = (pointer: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      const snapshot = system.getSnapshot();
      const current = snapshot.marbles.find((marble) => marble.id === snapshot.turn);
      if (!current) return;
      const { x, y, pulled, travel } = aimTarget(current, pointer);
      powerText
        .setText(`당긴 거리 ${Math.round(pulled)} px  ·  예상 이동 ${Math.round(travel)} px  ·  힘 ${Math.round(travel / 2)}%`)
        .setVisible(true);
      aimLine.setTo(current.x, current.y, x, y).setVisible(travel >= 8);
      pullLine.setTo(current.x, current.y, pointer.x, pointer.y).setVisible(true);
      drawTrajectory(current.x, current.y, x, y, travel);
    };
    const drawTrajectory = (
      startX: number,
      startY: number,
      endX: number,
      endY: number,
      length: number,
    ) => {
      trajectory.clear().setVisible(length >= 8);
      if (length < 8) return;
      const unitX = (endX - startX) / length;
      const unitY = (endY - startY) / length;
      trajectory.lineStyle(2, 0x1359ae, 1);
      for (let distance = 25; distance < length - 10; distance += 25) {
        const x = startX + unitX * distance;
        const y = startY + unitY * distance;
        trajectory.lineBetween(x - unitY * 5, y + unitX * 5, x + unitY * 5, y - unitX * 5);
      }
      trajectory.strokeCircle(endX, endY, 9);
    };
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      const snapshot = system.getSnapshot();
      const current = snapshot.marbles.find((marble) => marble.id === snapshot.turn);
      if (!current || !current.alive || snapshot.state !== "wait_move") return;
      if (this.settings.mode === "multi" && current.id !== this.settings.playerId) return;
      if (Math.hypot(pointer.x - current.x, pointer.y - current.y) > 40) return;
      this.dragging = true;
      this.aimTurn = current.id;
      updateAim(pointer);
    });
    this.input.on("pointermove", updateAim);
    const shoot = (pointer: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      this.cleanupAim(aimLine, pullLine, trajectory, powerText);
      const snapshot = system.getSnapshot();
      const current = snapshot.marbles.find((marble) => marble.id === snapshot.turn);
      if (
        !current || snapshot.state !== "wait_move" || snapshot.remainingSeconds === 0 ||
        this.aimTurn !== snapshot.turn ||
        (this.settings.mode === "multi" && current?.id !== this.settings.playerId)
      )
        return;
      const { x, y, travel } = aimTarget(current, pointer);
      if (travel < 8) return;
      if (this.socket) {
        const requestId = `${this.settings.gameId}-${this.settings.turnId}-${++this.requestSequence}`;
        this.socket?.emit(
          "game:move",
          {
            roomId: this.settings.roomId,
            gameId: this.settings.gameId,
            turnId: this.settings.turnId,
            requestId,
            x,
            y,
          },
          (result: { ok: boolean }) => {
            if (!result?.ok) this.cancelAim(aimLine, pullLine, trajectory, powerText);
          },
        );
      } else {
        system.moveMarble(x, y);
      }
    };
    this.input.on("pointerup", shoot);
    this.input.on("pointerupoutside", shoot);
    this.cleanup.push(() => {
      this.input.off("pointerdown");
      this.input.off("pointermove");
      this.input.off("pointerup");
      this.input.off("pointerupoutside");
    });
    const onBlur = () => this.cancelAim(aimLine, pullLine, trajectory, powerText);
    window.addEventListener("blur", onBlur);
    this.cleanup.push(() => window.removeEventListener("blur", onBlur));
    this.events.once("shutdown", () => this.cleanupScene());
    this.events.once("destroy", () => this.cleanupScene());
    if (system.getSnapshot().state !== "finished") this.settings.onReady?.();
  }

  private cleanupScene() {
    this.dragging = false;
    if (this.abortTimer !== undefined) window.clearTimeout(this.abortTimer);
    this.cleanup.splice(0).forEach((dispose) => dispose());
    this.system?.destroy();
  }

  private cleanupAim(
    aimLine: Phaser.GameObjects.Line,
    pullLine: Phaser.GameObjects.Line,
    trajectory: Phaser.GameObjects.Graphics,
    powerText: Phaser.GameObjects.Text,
  ) {
    this.dragging = false;
    aimLine.setVisible(false);
    pullLine.setVisible(false);
    trajectory.clear().setVisible(false);
    powerText.setVisible(false);
  }

  private cancelAim(
    aimLine: Phaser.GameObjects.Line,
    pullLine: Phaser.GameObjects.Line,
    trajectory: Phaser.GameObjects.Graphics,
    powerText: Phaser.GameObjects.Text,
  ) {
    this.aimTurn = -1;
    this.cleanupAim(aimLine, pullLine, trajectory, powerText);
  }

  private render(
    args: RenderArgs,
    marbleImages: Phaser.GameObjects.Image[],
    labels: Phaser.GameObjects.Text[],
    description: Phaser.GameObjects.Text,
    guideLine: Phaser.GameObjects.Line,
  ) {
    if (marbleImages.length === 0) {
      args.marbles.forEach(() => {
        marbleImages.push(this.add.image(0, 0, "marble_green").setDepth(1));
        labels.push(
          this.add
            .text(0, 0, "", {
              color: "#111",
              fontSize: 12,
              fontStyle: "bold",
              align: "center",
              backgroundColor: "#ffffffbb",
              padding: { x: 3, y: 2 },
            })
            .setOrigin(0.5, 1)
            .setDepth(2),
        );
      });
      args.holes.forEach((hole) => this.add.image(hole.x, hole.y, "hole"));
    }

    const current = args.marbles.find((marble) => marble.id === args.turn);
    description.setText(
      args.winner
        ? `${args.winner.name}님이 우승했습니다!`
        : args.state === "paused"
          ? "연결이 끊긴 플레이어를 기다리는 중입니다."
          : current
            ? `${current.name}님의 차례 · ${args.remainingSeconds}초\n구멍 +2 타격 +1 사자 처치 +2`
            : "게임이 종료되었습니다.",
    );
    args.marbles.forEach((marble, i) => {
      const image = marbleImages[i];
      const label = labels[i];
      image.setPosition(marble.x, marble.y).setTexture(marble.lion ? "marble_red" : "marble_green");
      image.setAlpha(marble.alive ? 1 : 0);
      label.setPosition(marble.x, marble.y - 18).setText(`${marble.name} · ${marble.score}`);
      label.setAlpha(marble.alive ? (marble.id === args.turn ? 1 : 0.65) : 0);
      if (marble.id === args.turn && marble.alive && args.state !== "finished") {
        const hole = args.holes[marble.hole];
        if (hole) {
          guideLine.setTo(marble.x, marble.y, hole.x, hole.y).setAlpha(1);
        } else {
          guideLine.setAlpha(0);
        }
      }
    });

    if (args.state === "finished" && !this.children.getByName("scoreboard")) {
      this.showScoreboard(args.marbles);
      this.settings.onFinished?.();
    }
  }

  private showLionHit(x: number, y: number) {
    const ring = this.add.circle(x, y, 16, 0xf1cc83, 0.25)
      .setStrokeStyle(3, 0xffd166)
      .setDepth(11);
    const points = this.add.text(
      Phaser.Math.Clamp(x, 36, this.scale.width - 36),
      Math.max(60, y - 22),
      "+2",
      { color: "#ffe2a9", fontSize: "26px", fontStyle: "bold", stroke: "#192c25", strokeThickness: 5 },
    ).setOrigin(0.5).setDepth(12);
    this.tweens.add({
      targets: ring,
      scale: 3.5,
      alpha: 0,
      duration: 460,
      ease: "Quad.Out",
      onComplete: () => ring.destroy(),
    });
    this.tweens.add({
      targets: points,
      y: points.y - 30,
      alpha: 0,
      duration: 700,
      ease: "Quad.Out",
      onComplete: () => points.destroy(),
    });
  }

  private showScoreboard(marbles: Marble[]) {
    const board = [...marbles]
      .sort((a, b) => b.score - a.score)
      .map((marble, index) => `${index + 1}. ${marble.name}  ${marble.score}점`)
      .join("\n");
    this.add
      .text(300, 650, `최종 순위\n\n${board}`, {
        color: "#f7f1df",
        fontSize: 28,
        align: "center",
        backgroundColor: "#192c25",
        padding: { x: 24, y: 20 },
      })
      .setName("scoreboard")
      .setOrigin(0.5)
      .setDepth(20);
  }
}

function aimTarget(marble: Marble, pointer: Phaser.Input.Pointer) {
  const dx = marble.x - pointer.x;
  const dy = marble.y - pointer.y;
  const pulled = Math.hypot(dx, dy);
  const scale = Math.min(200, pulled * AIM_SENSITIVITY) / (pulled || 1);
  const x = Phaser.Math.Clamp(marble.x + dx * scale, 10, GAME_WIDTH - 10);
  const y = Phaser.Math.Clamp(marble.y + dy * scale, 10, GAME_HEIGHT - 10);
  return { x, y, pulled, travel: Math.hypot(x - marble.x, y - marble.y) };
}
