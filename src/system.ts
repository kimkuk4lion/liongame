import {
  GAME_HEIGHT,
  GAME_WIDTH,
  MOVE_RANDOM,
  PUSH_DISTANCE_BASE,
  PUSH_DISTANCE_PER_FORCE,
} from "./constants";

export type Hole = { id: number; x: number; y: number };

export type Marble = {
  id: number;
  name: string;
  x: number;
  y: number;
  lion: boolean;
  hole: number;
  alive: boolean;
  inHole: boolean;
  score: number;
  eliminated?: boolean;
  eliminationReason?: string;
};

export type GameState = "wait_move" | "moving" | "paused" | "finished";

export type RenderArgs = {
  turn: number;
  marbles: Marble[];
  holes: Hole[];
  state: GameState;
  remainingSeconds: number;
  winner?: Marble;
};

export type MoveResult = { playerId: number; x: number; y: number; force: number };
export type RenderFunction = (args: RenderArgs) => void;

export const HOLES: Hole[] = [
  { id: 0, x: 300, y: 950 },
  { id: 1, x: 300, y: 700 },
  { id: 2, x: 300, y: 400 },
  { id: 3, x: 500, y: 400 },
  { id: 4, x: 100, y: 400 },
  { id: 5, x: 300, y: 150 },
];

const MARBLE_RADIUS = 25 / 2;
const HOLE_RADIUS = 35 / 2;
const TURN_LIMIT_MS = 10_000;
const SHOT_DURATION_MS = 1500;
const PUSH_DURATION_MS = 850;

export class System {
  private turn = 0;
  private readonly marbles: Marble[];
  private readonly holes = HOLES;
  private state: GameState = "wait_move";
  private remainingSeconds = 10;
  private turnStartedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private winner: Marble | undefined;
  private destroyed = false;
  private frameIds = new Set<number>();
  private readonly indexById = new Map<number, number>();
  private lastRenderedSeconds = 10;
  private serverAnimationToken = 0;

  constructor(
    playerIds: number[],
    private readonly renderFunction: RenderFunction,
    names: string[] = [],
    private readonly serverControlled = false
  ) {
    this.marbles = playerIds.map((id, i) => ({
      id,
      name: names[i] ?? `플레이어 ${i + 1}`,
      hole: 0,
      lion: false,
      x: 100 + i * (playerIds.length === 1 ? 0 : 400 / (playerIds.length - 1)),
      y: 1200,
      alive: true,
      inHole: true,
      score: 0,
    }));
    this.marbles.forEach((marble, index) => this.indexById.set(marble.id, index));
    this.timer = setInterval(() => this.tick(), 250);
  }

  moveMarble(x: number, y: number, playerId = this.turn, randomize = false): MoveResult | undefined {
    const index = this.indexById.get(playerId);
    if (this.destroyed || this.serverControlled || this.state !== "wait_move" || index === undefined || playerId !== this.turn || !this.marbles[index]?.alive) {
      return undefined;
    }
    const marble = this.marbles[index];
    const shotX = x - marble.x;
    const shotY = y - marble.y;
    const shotDistance = Math.hypot(shotX, shotY);
    const force = clamp(shotDistance / 2, 0, 100);
    if (randomize) {
      x = randomNumber(x - MOVE_RANDOM, x + MOVE_RANDOM);
      y = randomNumber(y - MOVE_RANDOM, y + MOVE_RANDOM);
    }
    x = clamp(x, 10, GAME_WIDTH - 10);
    y = clamp(y, 10, GAME_HEIGHT - 10);
    this.state = "moving";
    marble.inHole = false;
    const startX = marble.x;
    const startY = marble.y;
    const startedAt = performance.now();
    const f = () => {
      if (this.destroyed) return;
      const progress = Math.min(1, (performance.now() - startedAt) / SHOT_DURATION_MS);
      const easedProgress = 1 - Math.pow(1 - progress, 2);
      const previousX = marble.x;
      const previousY = marble.y;
      marble.x = startX + (x - startX) * easedProgress;
      marble.y = startY + (y - startY) * easedProgress;
      if (this.checkCollision(marble, shotX, shotY, force, previousX, previousY)) {
        return;
      }
      this.render();
      if (progress < 1) {
        this.trackFrame(f);
      } else {
        this.finishMove();
      }
    };
    f();
    return { playerId, x, y, force };
  }

  getSnapshot(): RenderArgs {
    return {
      turn: this.turn,
      holes: this.holes,
      marbles: this.marbles,
      state: this.state,
      remainingSeconds: this.remainingSeconds,
      winner: this.winner,
    };
  }

  render() {
    if (this.destroyed) return;
    this.renderFunction(this.getSnapshot());
  }

  destroy() {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.frameIds.forEach((frameId) => cancelAnimationFrame(frameId));
    this.frameIds.clear();
  }

  syncTurn(playerId: number, remainingMs: number) {
    const index = this.indexById.get(playerId);
    if (this.destroyed || index === undefined || !this.marbles[index]?.alive) return;
    this.turn = playerId;
    this.turnStartedAt = Date.now() - (TURN_LIMIT_MS - remainingMs);
    this.remainingSeconds = Math.ceil(Math.max(0, remainingMs) / 1000);
    this.state = "wait_move";
    this.lastRenderedSeconds = this.remainingSeconds;
    this.render();
  }

  applyServerState(state: {
    version: number;
    gameId?: number;
    turnId: number;
    turnPlayerId: number;
    deadline: number;
    pausedRemainingMs?: number;
    state: GameState;
    marbles: Marble[];
    winnerId?: number;
  }) {
    if (this.destroyed) return;
    const previousPositions = new Map(this.marbles.map((marble) => [marble.id, { x: marble.x, y: marble.y }]));
    const incoming = new Map(state.marbles.map((marble) => [marble.id, marble]));
    this.marbles.forEach((marble) => {
      const next = incoming.get(marble.id);
      if (next) {
        const position = previousPositions.get(marble.id);
        Object.assign(marble, next);
        if (position) {
          marble.x = position.x;
          marble.y = position.y;
        }
      }
    });
    this.turn = state.turnPlayerId;
    this.state = state.state;
    this.winner = state.winnerId === undefined ? undefined : this.marbles[this.indexById.get(state.winnerId) ?? -1];
    const remainingMs = state.state === "paused"
      ? state.pausedRemainingMs ?? 0
      : Math.max(0, state.deadline - Date.now());
    this.turnStartedAt = Date.now() - (TURN_LIMIT_MS - remainingMs);
    this.remainingSeconds = Math.ceil(remainingMs / 1000);
    this.lastRenderedSeconds = this.remainingSeconds;
    const token = ++this.serverAnimationToken;
    const start = performance.now();
    const duration = SHOT_DURATION_MS;
    const animate = (timestamp: number) => {
      if (this.destroyed || token !== this.serverAnimationToken) return;
      const progress = Math.min(1, (timestamp - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      this.marbles.forEach((marble) => {
        const from = previousPositions.get(marble.id);
        const target = incoming.get(marble.id);
        if (from && target) {
          marble.x = from.x + (target.x - from.x) * eased;
          marble.y = from.y + (target.y - from.y) * eased;
        }
      });
      this.render();
      if (progress < 1) this.trackFrame(animate);
    };
    this.trackFrame(animate);
  }

  private tick() {
    if (this.state === "finished" || this.serverControlled) return;
    this.remainingSeconds = Math.max(
      0,
      Math.ceil((TURN_LIMIT_MS - (Date.now() - this.turnStartedAt)) / 1000)
    );
    if (this.remainingSeconds !== this.lastRenderedSeconds) {
      this.lastRenderedSeconds = this.remainingSeconds;
      this.render();
    }
    if (this.state === "wait_move" && this.remainingSeconds === 0) {
      this.nextTurn();
      this.render();
    }
  }

  private nextTurn() {
    if (this.marbles.length === 0) return;
    for (let offset = 1; offset <= this.marbles.length; offset += 1) {
      const currentIndex = this.indexById.get(this.turn) ?? 0;
      const nextTurn = (currentIndex + offset) % this.marbles.length;
      if (!this.marbles[nextTurn].alive) continue;
      this.turn = this.marbles[nextTurn].id;
      this.turnStartedAt = Date.now();
      this.remainingSeconds = 10;
      return;
    }
    this.checkWinner();
  }

  private checkCollision(
    marble: Marble,
    shotX: number,
    shotY: number,
    force: number,
    previousX: number,
    previousY: number
  ): boolean {
    for (const other of this.marbles) {
      if (other.id === marble.id || !other.alive) continue;
      if (!collision(other.x, other.y, marble.x, marble.y, MARBLE_RADIUS, MARBLE_RADIUS)) continue;

      const shotLength = Math.hypot(shotX, shotY) || 1;
      const collisionX = other.x - marble.x;
      const collisionY = other.y - marble.y;
      const collisionLength = Math.hypot(collisionX, collisionY);
      const directionX = collisionLength > 0 ? collisionX / collisionLength : shotX / shotLength;
      const directionY = collisionLength > 0 ? collisionY / collisionLength : shotY / shotLength;
      const pushDistance = PUSH_DISTANCE_BASE + force * PUSH_DISTANCE_PER_FORCE;
      let targetX = clamp(other.x + directionX * pushDistance, 10, GAME_WIDTH - 10);
      let targetY = clamp(other.y + directionY * pushDistance, 10, GAME_HEIGHT - 10);
      if (marble.lion) {
        other.alive = false;
        marble.score += 2;
      } else if (other.lion) {
        marble.alive = false;
      } else {
        marble.score += 1;
        other.inHole = false;
      }
      this.checkWinner();
      if (other.alive) {
        this.animatePush(other, targetX, targetY, () => this.finishMove());
      } else {
        this.finishMove();
      }
      return true;
    }

    if (!marble.lion) {
      const targetHole = this.holes[marble.hole];
      if (
        collision(targetHole.x, targetHole.y, marble.x, marble.y, HOLE_RADIUS, MARBLE_RADIUS) ||
        segmentCollision(
          previousX,
          previousY,
          marble.x,
          marble.y,
          targetHole.x,
          targetHole.y,
          HOLE_RADIUS + MARBLE_RADIUS
        )
      ) {
        marble.score += 2;
        this.nextHole(marble);
        this.finishMove();
        return true;
      }
    }

    return false;
  }

  private nextHole(marble: Marble) {
    const targetHole = this.holes[marble.hole];
    marble.inHole = true;
    marble.x = targetHole.x;
    marble.y = targetHole.y;
    marble.hole += 1;
    if (marble.hole === this.holes.length) {
      marble.lion = true;
      marble.inHole = false;
    }
  }

  private finishMove() {
    this.state = this.winner ? "finished" : "wait_move";
    if (!this.winner) this.nextTurn();
    this.render();
  }

  private animatePush(marble: Marble, targetX: number, targetY: number, onComplete: () => void) {
    const startX = marble.x;
    const startY = marble.y;
    const startedAt = performance.now();
    const animate = () => {
      if (this.destroyed) return;
      const progress = Math.min(1, (performance.now() - startedAt) / PUSH_DURATION_MS);
      const easedProgress = 1 - Math.pow(1 - progress, 2);
      marble.x = clamp(startX + (targetX - startX) * easedProgress, 10, GAME_WIDTH - 10);
      marble.y = clamp(startY + (targetY - startY) * easedProgress, 10, GAME_HEIGHT - 10);
      this.render();
      if (progress < 1) {
        this.trackFrame(animate);
      } else {
        onComplete();
      }
    };
    this.trackFrame(animate);
  }

  private trackFrame(callback: FrameRequestCallback) {
    let frameId = 0;
    frameId = requestAnimationFrame((timestamp) => {
      this.frameIds.delete(frameId);
      callback(timestamp);
    });
    this.frameIds.add(frameId);
  }

  private checkWinner() {
    const alive = this.marbles.filter((marble) => marble.alive);
    const aliveLions = alive.filter((marble) => marble.lion);
    if (alive.length <= 1 || (aliveLions.length === 1 && alive.every((marble) => marble.lion))) {
      this.winner = [...this.marbles].sort((a, b) => b.score - a.score)[0];
      this.state = "finished";
    }
  }
}

function collision(x1: number, y1: number, x2: number, y2: number, d1: number, d2: number) {
  return Math.hypot(x1 - x2, y1 - y2) <= d1 + d2;
}

function segmentCollision(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  circleX: number,
  circleY: number,
  radius: number
) {
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
  const projection = segmentLengthSquared === 0
    ? 0
    : clamp(
        ((circleX - startX) * segmentX + (circleY - startY) * segmentY) /
          segmentLengthSquared,
        0,
        1
      );
  const closestX = startX + segmentX * projection;
  const closestY = startY + segmentY * projection;
  return Math.hypot(circleX - closestX, circleY - closestY) <= radius;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function randomNumber(min: number, max: number) {
  return Math.random() * (max - min) + min;
}
