<script setup lang="ts">
/**
 * 拍摄通告排期面板（总览页内嵌）：
 * - 未安排的镜头单独列出，选定拍摄日后追加到当日末尾
 * - 已排期镜头按拍摄日分组，当日可上下移动次序（只影响所在日期）
 * - 改到别日时从原清单移走、追加到新日期末尾
 * - 已完成镜头不接受日期调整，仅保留当日内调序
 * - 调整即时写入 IndexedDB，切页 / 关闭浏览器后保持原样
 */
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useScheduleStore, ScheduleGuardError } from '../../stores/scheduleStore';
import { useFrameStore } from '../../stores/frameStore';
import { durationToFrames } from '../../utils/frameMath';
import StatusTag from '../common/StatusTag.vue';
import EmptyState from '../common/EmptyState.vue';
import type { Shot } from '../../types/shot';

interface Row {
  shot: Shot;
}

const props = defineProps<{
  rows: Row[];
}>();

const router = useRouter();
const frameStore = useFrameStore();
const scheduleStore = useScheduleStore();
const { schedules } = storeToRefs(scheduleStore);

/** 未安排清单里每行的日期草稿：只在点「安排」后才落库 */
const drafts = reactive<Record<number, string>>({});
/** 已排期镜头改期草稿，空串表示沿用原日期 */
const moveDrafts = reactive<Record<number, string>>({});
const busy = ref(false);
const errorText = ref('');

const shotMap = computed(() => {
  const map = new Map<number, Row>();
  for (const row of props.rows) {
    if (typeof row.shot.id === 'number') map.set(row.shot.id, row);
  }
  return map;
});

interface ScheduleRow {
  schedule: (typeof schedules.value)[number];
  shot: Shot;
  planned: number;
  done: boolean;
}

interface DayGroup {
  date: string;
  weekday: string;
  rows: ScheduleRow[];
  shotCount: number;
  plannedTotal: number;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function weekdayOf(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getDay()];
}

const scheduledRows = computed<ScheduleRow[]>(() =>
  schedules.value
    .slice()
    .sort((a, b) => (a.shootDate < b.shootDate ? -1 : a.shootDate > b.shootDate ? 1 : a.order - b.order))
    .map((schedule) => {
      const row = shotMap.value.get(schedule.shotId);
      const shot = row?.shot;
      if (!shot) return null;
      return {
        schedule,
        shot,
        planned: durationToFrames(shot.durationSec, shot.fps),
        done: shot.status === '已完成',
      };
    })
    .filter((x): x is ScheduleRow => x !== null),
);

const dayGroups = computed<DayGroup[]>(() => {
  const groups = new Map<string, ScheduleRow[]>();
  for (const row of scheduledRows.value) {
    const list = groups.get(row.schedule.shootDate) ?? [];
    list.push(row);
    groups.set(row.schedule.shootDate, list);
  }
  return [...groups.keys()].sort().map((date) => {
    const list = groups.get(date) ?? [];
    return {
      date,
      weekday: weekdayOf(date),
      rows: list,
      shotCount: list.length,
      plannedTotal: list.reduce((sum, r) => sum + r.planned, 0),
    };
  });
});

const unscheduledRows = computed(() =>
  props.rows
    .filter((row) => typeof row.shot.id === 'number' && !scheduleStore.scheduledShotIds.has(row.shot.id))
    .slice()
    .sort((a, b) => a.shot.code.localeCompare(b.shot.code, 'zh-Hans-CN')),
);

async function runGuard(action: () => Promise<void>) {
  if (busy.value) return;
  errorText.value = '';
  busy.value = true;
  try {
    await action();
  } catch (e) {
    errorText.value = e instanceof ScheduleGuardError ? e.message : '排期保存失败，请重试';
    // eslint-disable-next-line no-console
    console.error('[schedule]', e);
  } finally {
    busy.value = false;
  }
}

function assignShot(shotId: number) {
  const date = drafts[shotId];
  if (!date) {
    errorText.value = '请先选择拍摄日';
    return;
  }
  void runGuard(async () => {
    await scheduleStore.assign(shotId, date);
    delete drafts[shotId];
  });
}

function reschedule(row: ScheduleRow) {
  const date = moveDrafts[row.schedule.shotId];
  if (!date || date === row.schedule.shootDate) return;
  void runGuard(async () => {
    await scheduleStore.assign(row.schedule.shotId, date);
    delete moveDrafts[row.schedule.shotId];
  });
}

function unassign(row: ScheduleRow) {
  void runGuard(async () => {
    await scheduleStore.unassign(row.schedule.shotId);
    delete moveDrafts[row.schedule.shotId];
  });
}

function moveUp(row: ScheduleRow) {
  void runGuard(() => scheduleStore.move(row.schedule.shotId, -1));
}

function moveDown(row: ScheduleRow) {
  void runGuard(() => scheduleStore.move(row.schedule.shotId, 1));
}

function goDetail(id: number | undefined) {
  if (typeof id !== 'number') return;
  void frameStore.loadForShot(id);
  void router.push(`/shots/${id}`);
}
</script>

<template>
  <div class="schedule-board">
    <p v-if="errorText" class="error-banner" role="alert">{{ errorText }}</p>

    <EmptyState
      v-if="!rows.length"
      title="还没有可排期的镜头"
      description="先在镜头清单里创建镜头，再回来指定拍摄日、排出当天顺序。"
    />

    <template v-else>
      <!-- 未安排日期的镜头 -->
      <section class="panel unscheduled">
        <div class="panel-head">
          <h2>未安排日期</h2>
          <span class="muted">{{ unscheduledRows.length }} 个镜头待指定拍摄日</span>
        </div>
        <p v-if="!unscheduledRows.length" class="muted empty-line">所有镜头都已排入拍摄日。</p>
        <ul v-else class="shot-list">
          <li v-for="row in unscheduledRows" :key="row.shot.id" class="shot-item">
            <div class="shot-main">
              <button type="button" class="link" @click="goDetail(row.shot.id)">{{ row.shot.code }}</button>
              <span class="scene">{{ row.shot.sceneName || '未填场景' }}</span>
              <StatusTag :status="row.shot.status" size="small" />
              <span class="muted plan">{{ durationToFrames(row.shot.durationSec, row.shot.fps) }} 张</span>
            </div>
            <div class="shot-ops">
              <input
                v-model="drafts[row.shot.id as number]"
                type="date"
                class="date-input"
                :disabled="row.shot.status === '已完成' || busy"
                :title="row.shot.status === '已完成' ? '已完成的镜头不再接受日期调整' : ''"
              />
              <button
                type="button"
                class="btn small primary"
                :disabled="row.shot.status === '已完成' || busy"
                :title="row.shot.status === '已完成' ? '已完成的镜头不再接受日期调整' : '追加到所选日期清单末尾'"
                @click="assignShot(row.shot.id as number)"
              >
                安排到当日末尾
              </button>
            </div>
          </li>
        </ul>
      </section>

      <!-- 各拍摄日通告单 -->
      <p v-if="!dayGroups.length" class="muted hint">在上方为镜头选择拍摄日后，这里会按天合成通告单。</p>

      <section v-for="(day, dayIdx) in dayGroups" :key="day.date" class="panel day-panel">
        <div class="panel-head day-head">
          <h2>
            第 {{ dayIdx + 1 }} 拍摄日
            <span class="date-text mono">{{ day.date }}（{{ day.weekday }}）</span>
          </h2>
          <span class="day-total">
            镜头 <strong>{{ day.shotCount }}</strong> 个 · 计划 <strong>{{ day.plannedTotal }}</strong> 张
          </span>
        </div>

        <ul class="shot-list">
          <li v-for="(row, idx) in day.rows" :key="row.schedule.shotId" class="shot-item scheduled">
            <div class="order-cell">
              <span class="order-no">{{ idx + 1 }}</span>
              <div class="order-btns">
                <button
                  type="button"
                  class="icon-btn"
                  title="上移（仅当日次序）"
                  :disabled="idx === 0 || busy"
                  @click="moveUp(row)"
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="icon-btn"
                  title="下移（仅当日次序）"
                  :disabled="idx === day.rows.length - 1 || busy"
                  @click="moveDown(row)"
                >
                  ↓
                </button>
              </div>
            </div>
            <div class="shot-main">
              <button type="button" class="link" @click="goDetail(row.shot.id)">{{ row.shot.code }}</button>
              <span class="scene">{{ row.shot.sceneName || '未填场景' }}</span>
              <StatusTag :status="row.shot.status" size="small" />
              <span class="muted plan">计划 {{ row.planned }} 张</span>
            </div>
            <div class="shot-ops">
              <input
                v-model="moveDrafts[row.schedule.shotId]"
                type="date"
                class="date-input"
                :disabled="row.done || busy"
                :title="row.done ? '已完成的镜头不再调整日期' : '改到别日：移到该日清单末尾'"
              />
              <button
                type="button"
                class="btn small"
                :disabled="row.done || busy || !moveDrafts[row.schedule.shotId] || moveDrafts[row.schedule.shotId] === day.date"
                @click="reschedule(row)"
              >
                改到别日
              </button>
              <button
                type="button"
                class="btn small ghost"
                :disabled="row.done || busy"
                :title="row.done ? '已完成的镜头不再调整日期' : '取消安排，回到未安排清单'"
                @click="unassign(row)"
              >
                移出
              </button>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.schedule-board {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.error-banner {
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: #fdecec;
  border: 1px solid #f5c2c2;
  color: #c45656;
  font-size: 13px;
}
.panel {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 14px 16px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.panel-head h2 {
  margin: 0;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 400;
}
.date-text {
  font-size: 13px;
  color: #4a5464;
}
.day-total {
  font-size: 13px;
  color: #4a5464;
}
.day-total strong {
  color: #1f2d3d;
  font-size: 15px;
}
.day-panel {
  border-left: 3px solid #2f6fed;
}
.unscheduled {
  border-style: dashed;
}
.empty-line {
  margin: 4px 0;
}
.hint {
  margin: 2px 0;
}
.shot-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.shot-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid #eef1f6;
  border-radius: 8px;
  background: #fbfcfe;
}
.shot-item.scheduled {
  background: #fff;
}
.order-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 74px;
}
.order-no {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: #eaf1ff;
  color: #2f6fed;
  font-weight: 700;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.order-btns {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.icon-btn {
  width: 22px;
  height: 16px;
  padding: 0;
  border: 1px solid #d5dce6;
  border-radius: 4px;
  background: #fff;
  color: #4a5464;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
}
.icon-btn:hover:not(:disabled) {
  border-color: #2f6fed;
  color: #2f6fed;
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.shot-main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
}
.link {
  border: none;
  background: none;
  padding: 0;
  color: #2f6fed;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.link:hover {
  text-decoration: underline;
}
.scene {
  font-size: 13px;
  color: #1f2d3d;
}
.plan {
  font-size: 12px;
}
.shot-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.date-input {
  height: 28px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 12px;
  color: #1f2d3d;
  background: #fff;
}
.date-input:disabled {
  background: #f4f6fa;
  color: #a7b0bf;
  cursor: not-allowed;
}
.btn {
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 12px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.ghost {
  color: #8a94a6;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
