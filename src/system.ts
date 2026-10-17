import { GAME_HEIGHT, GAME_WIDTH, MOVE_RANDOM } from "./constants";

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
};

export type GameState = "wait_move" | "moving" | "finished";

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

  constructor(
    private readonly marbleCount: number,
    private readonly renderFunction: RenderFunction,
    names: string[] = []
  ) {
    this.marbles = Array.from({ length: marbleCount }, (_, i) => ({
      id: i,
      name: names[i] ?? `플레이어 ${i + 1}`,
      hole: 0,
      lion: false,
      x: 100 + i * (marbleCount === 1 ? 0 : 400 / (marbleCount - 1)),
      y: 1200,
      alive: true,
      inHole: true,
      score: 0,
    }));
    this.timer = setInterval(() => this.tick(), 250);
  }

  moveMarble(x: number, y: number, playerId = this.turn, randomize = false): MoveResult | undefined {
    if (this.state !== "wait_move" || playerId !== this.turn || !this.marbles[playerId]?.alive) {
      return undefined;
    }
    const marble = this.marbles[playerId];
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
        requestAnimationFrame(f);
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
    this.renderFunction(this.getSnapshot());
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private tick() {
    if (this.state === "finished") return;
    this.remainingSeconds = Math.max(
      0,
      Math.ceil((TURN_LIMIT_MS - (Date.now() - this.turnStartedAt)) / 1000)
    );
    if (this.state === "wait_move" && this.remainingSeconds === 0) {
      this.nextTurn();
      this.render();
    }
  }

  private nextTurn() {
    if (this.marbles.length === 0) return;
    for (let offset = 1; offset <= this.marbleCount; offset += 1) {
      const nextTurn = (this.turn + offset) % this.marbleCount;
      if (!this.marbles[nextTurn].alive) continue;
      this.turn = nextTurn;
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
      if (other.inHole || this.isAtHole(other)) continue;
      if (!collision(other.x, other.y, marble.x, marble.y, MARBLE_RADIUS, MARBLE_RADIUS)) continue;

      const shotLength = Math.hypot(shotX, shotY) || 1;
      const collisionX = other.x - marble.x;
      const collisionY = other.y - marble.y;
      const collisionLength = Math.hypot(collisionX, collisionY);
      const directionX = collisionLength > 0 ? collisionX / collisionLength : shotX / shotLength;
      const directionY = collisionLength > 0 ? collisionY / collisionLength : shotY / shotLength;
      const pushDistance = 80 + force * 3;
      let targetX = clamp(other.x + directionX * pushDistance, 10, GAME_WIDTH - 10);
      let targetY = clamp(other.y + directionY * pushDistance, 10, GAME_HEIGHT - 10);
      if (marble.lion) {
        other.alive = false;
        marble.score += 2;
      } else if (other.lion) {
        marble.alive = false;
      } else {
        marble.score += 1;
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
    if (marble.hole === this.holes.length) marble.lion = true;
  }

  private isAtHole(marble: Marble) {
    return this.holes.some((hole) =>
      collision(hole.x, hole.y, marble.x, marble.y, HOLE_RADIUS, MARBLE_RADIUS)
    );
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
      const progress = Math.min(1, (performance.now() - startedAt) / PUSH_DURATION_MS);
      const easedProgress = 1 - Math.pow(1 - progress, 2);
      marble.x = clamp(startX + (targetX - startX) * easedProgress, 10, GAME_WIDTH - 10);
      marble.y = clamp(startY + (targetY - startY) * easedProgress, 10, GAME_HEIGHT - 10);
      this.render();
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        onComplete();
      }
    };
    requestAnimationFrame(animate);
  }

  private checkWinner() {
    const alive = this.marbles.filter((marble) => marble.alive);
    const aliveLions = alive.filter((marble) => marble.lion);
    if (alive.length <= 1 || (aliveLions.length === 1 && alive.every((marble) => marble.lion))) {
      this.winner = [...alive].sort((a, b) => b.score - a.score)[0];
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
