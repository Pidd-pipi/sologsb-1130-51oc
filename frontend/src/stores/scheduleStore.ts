/**
 * 排期 store：镜头 → 拍摄日 / 当日次序。
 *
 * 约定：
 * - assign  指定（或改到）某拍摄日：追加到该日清单末尾；已在别日则从原清单移走
 * - unassign 取消日期：回到「未安排」
 * - move 只在同一拍摄日内上下移动，重排当日次序，不跨日
 * - 已完成（状态「已完成」）的镜头拒绝一切日期调整，仅允许当日内调序
 * - 所有调整即时落 IndexedDB，切页 / 关闭浏览器后再回来保持原样
 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { useShotStore } from './shotStore';
import type { ShotSchedule } from '../types/schedule';

interface ScheduleState {
  schedules: ShotSchedule[];
  ready: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ScheduleGuardError extends Error {}

/** 按拍摄日、当日次序排好 */
function sortRows(rows: ShotSchedule[]): ShotSchedule[] {
  return rows.slice().sort((a, b) => (a.shootDate < b.shootDate ? -1 : a.shootDate > b.shootDate ? 1 : a.order - b.order));
}

/** 重新编号：同一拍摄日内从 1 连续编号 */
function renumber(rows: ShotSchedule[]): ShotSchedule[] {
  const counters = new Map<string, number>();
  return sortRows(rows).map((row) => {
    const next = (counters.get(row.shootDate) ?? 0) + 1;
    counters.set(row.shootDate, next);
    return { ...row, order: next };
  });
}

export const useScheduleStore = defineStore('schedule', {
  state: (): ScheduleState => ({
    schedules: [],
    ready: false,
  }),
  getters: {
    /** shotId → 排期记录 */
    byShot(state): Map<number, ShotSchedule> {
      return new Map(state.schedules.map((r) => [r.shotId, r]));
    },
    /** 有排期的镜头 id 集合 */
    scheduledShotIds(state): Set<number> {
      return new Set(state.schedules.map((r) => r.shotId));
    },
  },
  actions: {
    /** 读取排期，并清理镜头已删除 / 已不存在的悬空记录 */
    async load() {
      const [rows, shots] = await Promise.all([api.listSchedules(), api.listShots()]);
      const validIds = new Set(shots.map((s) => s.id).filter((id): id is number => typeof id === 'number'));
      const kept = rows.filter((r) => validIds.has(r.shotId));
      const normalized = renumber(kept);
      // 仅在存在悬空记录或次序不连续时回写一次
      if (kept.length !== rows.length || normalized.some((r, i) => r !== rows[i])) {
        this.schedules = await api.saveSchedules(rows, normalized);
      } else {
        this.schedules = sortRows(rows);
      }
      this.ready = true;
    },
    /** 已完成镜头不接受日期调整 */
    guardWritable(shotId: number) {
      const shotStore = useShotStore();
      const shot = shotStore.byId(shotId);
      if (shot && shot.status === '已完成') {
        throw new ScheduleGuardError('已完成的镜头不再接受日期调整');
      }
    },
    /** 计算调整后的完整清单（不落库） */
    buildNext(shotId: number, shootDate: string): ShotSchedule[] {
      const existing = this.schedules.find((r) => r.shotId === shotId);
      const targetCount = this.schedules.filter((r) => r.shootDate === shootDate).length;
      if (existing) {
        // 改到别日：从原清单移走，追加到当日末尾
        return this.schedules.map((r) =>
          r.shotId === shotId ? { ...r, shootDate, order: targetCount + 1 } : r,
        );
      }
      const shotStore = useShotStore();
      const shot = shotStore.byId(shotId);
      const row: ShotSchedule = {
        shotId,
        shotCode: shot?.code ?? String(shotId),
        shootDate,
        order: targetCount + 1,
        updatedAt: Date.now(),
      };
      return [...this.schedules, row];
    },
    /** 指定拍摄日 / 改到别日：校验后追加到当日清单末尾 */
    async assign(shotId: number, shootDate: string) {
      if (!DATE_RE.test(shootDate) || Number.isNaN(new Date(`${shootDate}T00:00:00`).getTime())) {
        throw new ScheduleGuardError('拍摄日格式不正确');
      }
      this.guardWritable(shotId);
      const prev = this.schedules;
      const next = renumber(this.buildNext(shotId, shootDate));
      this.schedules = await api.saveSchedules(prev, next);
    },
    /** 取消安排：从当日清单移走，回到「未安排」 */
    async unassign(shotId: number) {
      this.guardWritable(shotId);
      const prev = this.schedules;
      const next = renumber(prev.filter((r) => r.shotId !== shotId));
      this.schedules = await api.saveSchedules(prev, next);
    },
    /**
     * 当日内上下移动：只改所在日期的次序。
     * direction -1 上移，+1 下移；已到两端时为空操作。
     */
    async move(shotId: number, direction: -1 | 1) {
      const current = this.schedules.find((r) => r.shotId === shotId);
      if (!current) return;
      const sameDay = this.schedules
        .filter((r) => r.shootDate === current.shootDate)
        .sort((a, b) => a.order - b.order);
      const index = sameDay.findIndex((r) => r.shotId === shotId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= sameDay.length) return;
      const reordered = sameDay.slice();
      [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
      const orderMap = new Map<number, number>(reordered.map((r, i) => [r.shotId, i + 1]));
      const prev = this.schedules;
      const next = prev.map((r) =>
        r.shootDate === current.shootDate ? { ...r, order: orderMap.get(r.shotId) ?? r.order } : r,
      );
      this.schedules = await api.saveSchedules(prev, sortRows(next));
    },
  },
});
