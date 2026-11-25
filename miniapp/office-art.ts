import * as art from '../client/src/art';
import { type Pose, type Sprite } from '../client/src/art/api';
import { seasonalThemeFor } from '../client/src/world/api';
import { layoutProjectRoom } from '../client/src/world/layout/room';
import { type AreaVis, buildAreaVis, furnitureSprites, WALL_MARGIN, wallItemOrigin, wallSprites } from '../client/src/world/render/scene';
import { seasonalCostume, seasonalFurniture } from '../client/src/world/render/seasonal';
import type { AppearanceParts } from '../shared/appearance';
import type { AgentStatus } from '../shared/types';

interface PixelAgent {
  seed: number;
  look?: 'f' | 'm';
  parts?: AppearanceParts;
  sub?: boolean;
  status: AgentStatus;
}

interface PixelRoom {
  name: string;
  seed: number;
  slot?: number;
}

interface Placement {
  sprite: Sprite;
  x: number;
  y: number;
  depth: number;
}

const roomCache = new Map<string, AreaVis>();

export function drawAvatar(canvas: HTMLCanvasElement, agent: PixelAgent): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const avatar = art.avatarCanvas(agent.seed, { look: agent.look, parts: agent.parts, sub: agent.sub, scale: 2 });
  canvas.width = avatar.width;
  canvas.height = avatar.height;
  ctx.drawImage(avatar, 0, 0);
  return true;
}

function seatedPose(status: AgentStatus): Pose {
  if (status === 'waiting') return 'raise_hand';
  if (status === 'working' || status === 'shell') return 'type';
  return 'sleep';
}

function roomVisual(room: PixelRoom, theme: ReturnType<typeof seasonalThemeFor>): AreaVis {
  // A local slot preserves the orientation without giving the phone the building's full footprint.
  const slot = Number.isInteger(room.slot) ? room.slot! % 2 : 0;
  const key = JSON.stringify([room.name, room.seed, slot, theme]);
  const cached = roomCache.get(key);
  if (cached) return cached;
  const layout = layoutProjectRoom({ id: room.name, slot, seed: room.seed }, art.roomTheme(room.seed));
  const scene = buildAreaVis(art, layout, undefined, null, theme);
  if (roomCache.size >= 16) roomCache.clear();
  roomCache.set(key, scene);
  return scene;
}

export function drawRoom(canvas: HTMLCanvasElement, room: PixelRoom, agents: PixelAgent[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  const theme = seasonalThemeFor(undefined, new Date());
  const scene = roomVisual(room, theme);
  const { x, y, w, h } = scene.px;
  canvas.width = w;
  canvas.height = h + WALL_MARGIN;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#242b3b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(scene.floor, 0, WALL_MARGIN);
  ctx.drawImage(scene.walls, 0, 0);
  ctx.translate(-x, WALL_MARGIN - y);
  for (const item of scene.wallItems) {
    const sprite = wallSprites(art, item.kind, item.variant, 0, item.seed)?.base;
    if (!sprite) continue;
    const point = wallItemOrigin(item, sprite);
    ctx.drawImage(sprite.canvas, point.x, point.y);
  }

  const placements: Placement[] = [];
  for (const furniture of scene.furniture) {
    const seasonal = seasonalFurniture(theme, furniture.kind, scene.layout, furniture.seed);
    const sprites = seasonal ? { base: seasonal } : furnitureSprites(art, furniture);
    if (!sprites) continue;
    placements.push({ sprite: sprites.base, x: furniture.ax, y: furniture.ay, depth: furniture.ay });
    if (sprites.front) {
      placements.push({ sprite: sprites.front, x: furniture.ax, y: furniture.ay, depth: furniture.ay + 0.5 });
    }
  }
  const desks = scene.layout.spots.filter(({ kind }) => kind === 'desk').sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const seats = [...desks, ...scene.layout.spots.filter(({ kind }) => kind === 'stool' || kind === 'nook' || kind === 'stand')];
  const labels = [];
  for (let index = 0; index < agents.length && index < seats.length; index++) {
    const agent = agents[index];
    const seat = seats[index];
    const appearance = art.appearanceFromSeed(agent.seed, { look: agent.look, parts: agent.parts, sub: agent.sub });
    const sprite = art.characterSprite({
      appearance, dir: seat.dir, seated: seat.seated, pose: seat.seated ? seatedPose(agent.status) : 'stand',
      frame: agent.seed % 2, costume: seasonalCostume(theme, agent.seed),
    });
    placements.push({ sprite, x: seat.x, y: seat.y, depth: seat.sortY ?? seat.y });
    if (agent.status === 'idle' || agent.status === 'waiting') {
      const icon = art.iconSprite(agent.status === 'idle' ? 'zzz' : 'alert');
      placements.push({ sprite: icon, x: seat.x + 8, y: seat.y - sprite.ay + 6, depth: Infinity });
    }
    const stagger = Math.round((seat.x - x) / (art.TILE * 2)) % 2 ? 12 : 0;
    labels.push({
      x: 100 * Math.min(w - 21, Math.max(21, seat.x - x)) / w,
      y: 100 * (seat.y - y + WALL_MARGIN + stagger) / canvas.height,
    });
  }
  for (const { sprite, x: px, y: py } of placements.sort((a, b) => a.depth - b.depth)) {
    ctx.drawImage(sprite.canvas, Math.round(px - sprite.ax), Math.round(py - sprite.ay));
  }
  return labels;
}
