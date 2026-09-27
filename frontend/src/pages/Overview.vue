<script setup lang="ts">
/**
 * 进度总览：列出各镜头状态、帧数、预计时长与完成百分比，
 * 累计全片张数与待拍张数。消费 Shot、TakeLog、FrameEntry。
 * 拍摄排期：按场景集中拍摄，给镜头指定拍摄日并排定当日顺序，
 * 每日合计镜头数与计划张数，供场记拼通告单。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useShotStore } from '../stores/shotStore';
import { useFrameStore } from '../stores/frameStore';
import { useProgress } from '../hooks/useProgress';
import { listAllFrames } from '../db/api';
import { durationToFrames, framesToDuration } from '../utils/frameMath';
import { formatDateTime } from '../utils/format';
import ShotProgress from '../components/common/ShotProgress.vue';
import StatusTag from '../components/common/StatusTag.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { FrameEntry } from '../types/frame';
import type { Shot } from '../types/shot';

const router = useRouter();
const shotStore = useShotStore();
const frameStore = useFrameStore();
const { shots } = storeToRefs(shotStore);
const { summaries, overall, loadTakes, loading } = useProgress();

const allFrames = ref<FrameEntry[]>([]);

onMounted(async () => {
  await shotStore.load();
  await loadTakes();
  allFrames.value = await listAllFrames();
});

const summaryOf = (shotId: number | undefined) => summaries.value.find((s) => s.shotId === shotId);

const rows = computed(() =>
  shots.value.map((shot) => {
    const frames = allFrames.value.filter((f) => f.shotId === shot.id);
    const summary = summaryOf(shot.id);
    return {
      shot,
      frameCount: frames.length,
      duration: framesToDuration(shot.endFrame - shot.startFrame + 1, shot.fps),
      summary,
    };
  }),
);

const waitingFrames = computed(() => overall.value.remaining);
const statusCount = computed(() => ({
  idle: shots.value.filter((s) => s.status === '未开机').length,
  shooting: shots.value.filter((s) => s.status === '拍摄中').length,
  done: shots.value.filter((s) => s.status === '已完成').length,
}));

/* ---------------- 拍摄排期 ---------------- */

/** 单镜头计划张数（与进度统计口径一致：时长 × 帧率向上取整） */
const plannedOf = (shot: Shot) => durationToFrames(shot.durationSec, shot.fps);

/** 同日内按当日次序排序，次序相同（旧数据）时按镜号兜底 */
const byDayOrder = (a: Shot, b: Shot) => a.dayOrder - b.dayOrder || a.code.localeCompare(b.code, 'zh-Hans-CN');

/** 已排期的拍摄日，按日期升序；每天合计镜头数与计划张数 */
const scheduleDays = computed(() => {
  const map = new Map<string, Shot[]>();
  for (const shot of shots.value) {
    if (!shot.shootDate) continue;
    const list = map.get(shot.shootDate) ?? [];
    list.push(shot);
    map.set(shot.shootDate, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => {
      const rows = list.slice().sort(byDayOrder);
      return { date, rows, planned: rows.reduce((sum, s) => sum + plannedOf(s), 0) };
    });
});

/** 未安排拍摄日的镜头，单独列出 */
const unscheduled = computed(() =>
  shots.value
    .filter((s) => !s.shootDate)
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')),
);
const unscheduledPlanned = computed(() => unscheduled.value.reduce((sum, s) => sum + plannedOf(s), 0));

const isDone = (shot: Shot) => shot.status === '已完成';

async function onDateChange(shot: Shot, event: Event) {
  if (typeof shot.id !== 'number') return;
  const value = (event.target as HTMLInputElement).value;
  await shotStore.assignShootDate(shot.id, value);
}

async function unschedule(shot: Shot) {
  if (typeof shot.id !== 'number') return;
  await shotStore.assignShootDate(shot.id, '');
}

async function move(shot: Shot, dir: -1 | 1) {
  if (typeof shot.id !== 'number') return;
  await shotStore.moveInDay(shot.id, dir);
}

function goDetail(id: number | undefined) {
  if (typeof id !== 'number') return;
  void frameStore.loadForShot(id);
  void router.push(`/shots/${id}`);
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>进度总览</h1>
        <p class="sub">定格动画拍摄全片的镜头状态、帧序规模与实拍完成度</p>
      </div>
      <div class="head-actions">
        <button type="button" class="btn primary" @click="router.push('/shots/new')">新建镜头</button>
        <button type="button" class="btn" @click="router.push('/frames')">帧序编排台</button>
      </div>
    </header>

    <div class="stat-row">
      <div class="stat">
        <span class="label">镜头总数</span>
        <span class="value">{{ shots.length }}</span>
        <span class="hint">未开机 {{ statusCount.idle }} · 拍摄中 {{ statusCount.shooting }} · 已完成 {{ statusCount.done }}</span>
      </div>
      <div class="stat">
        <span class="label">全片计划张数</span>
        <span class="value">{{ overall.planned }}</span>
        <span class="hint">已登记帧条目 {{ allFrames.length }} 条</span>
      </div>
      <div class="stat">
        <span class="label">累计实拍张数</span>
        <span class="value">{{ overall.taken }}</span>
        <span class="hint">废帧 {{ overall.wasted }} 张</span>
      </div>
      <div class="stat">
        <span class="label">待拍张数</span>
        <span class="value">{{ waitingFrames }}</span>
        <span class="hint">整体完成 {{ overall.percent }}%</span>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>拍摄排期</h2>
        <span class="muted">按场景集中拍摄 · 指定日期后追加到当日末尾 · 已完成镜头排期锁定</span>
      </div>

      <EmptyState
        v-if="!shots.length"
        title="还没有镜头"
        description="创建镜头后，在这里给镜头指定拍摄日并安排当日顺序。"
        action-text="新建镜头"
        @action="router.push('/shots/new')"
      />

      <template v-else>
        <div v-for="day in scheduleDays" :key="day.date" class="day-block" data-testid="schedule-day">
          <div class="day-head">
            <span class="day-title mono">{{ day.date }}</span>
            <span class="muted">共 {{ day.rows.length }} 个镜头 · 计划 {{ day.planned }} 张</span>
          </div>
          <table class="table">
            <thead>
              <tr>
                <th class="order-col">顺序</th>
                <th>镜号</th>
                <th>场景</th>
                <th>状态</th>
                <th>计划张数</th>
                <th>拍摄日</th>
                <th>当日排序</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(shot, idx) in day.rows" :key="shot.id">
                <td class="mono order-col">{{ idx + 1 }}</td>
                <td class="mono">{{ shot.code }}</td>
                <td>{{ shot.sceneName }}</td>
                <td><StatusTag :status="shot.status" size="small" /></td>
                <td>{{ plannedOf(shot) }}</td>
                <td>
                  <div class="date-cell">
                    <input
                      type="date"
                      class="date-input"
                      :value="shot.shootDate"
                      :disabled="isDone(shot)"
                      :title="isDone(shot) ? '已完成镜头的排期不可再调整' : '改到别的拍摄日'"
                      @change="onDateChange(shot, $event)"
                    />
                    <button
                      v-if="!isDone(shot)"
                      type="button"
                      class="btn small"
                      title="移回未排期"
                      @click="unschedule(shot)"
                    >
                      移出
                    </button>
                  </div>
                </td>
                <td>
                  <div class="order-btns">
                    <button
                      type="button"
                      class="btn small"
                      :disabled="idx === 0 || isDone(shot)"
                      @click="move(shot, -1)"
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      class="btn small"
                      :disabled="idx === day.rows.length - 1 || isDone(shot)"
                      @click="move(shot, 1)"
                    >
                      下移
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="day-block unscheduled" data-testid="unscheduled-block">
          <div class="day-head">
            <span class="day-title">未排期</span>
            <span class="muted">共 {{ unscheduled.length }} 个镜头 · 计划 {{ unscheduledPlanned }} 张</span>
          </div>
          <p v-if="!unscheduled.length" class="muted empty-line">所有镜头都已安排拍摄日。</p>
          <table v-else class="table">
            <thead>
              <tr>
                <th>镜号</th>
                <th>场景</th>
                <th>状态</th>
                <th>计划张数</th>
                <th>指定拍摄日</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="shot in unscheduled" :key="shot.id">
                <td class="mono">{{ shot.code }}</td>
                <td>{{ shot.sceneName }}</td>
                <td><StatusTag :status="shot.status" size="small" /></td>
                <td>{{ plannedOf(shot) }}</td>
                <td>
                  <input
                    type="date"
                    class="date-input"
                    value=""
                    :disabled="isDone(shot)"
                    :title="isDone(shot) ? '已完成镜头的排期不可再调整' : '指定后追加到当日末尾'"
                    @change="onDateChange(shot, $event)"
                  />
                  <span v-if="isDone(shot)" class="muted lock-hint">已完成，不排期</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>镜头清单</h2>
        <span class="muted">{{ loading ? '读取实拍记录中…' : '数据来源：IndexedDB（gbstopmotion-db）' }}</span>
      </div>

      <EmptyState
        v-if="!rows.length"
        title="还没有镜头"
        description="创建第一个镜头后，这里会汇总各镜头的帧数与完成百分比。"
        action-text="新建镜头"
        @action="router.push('/shots/new')"
      />

      <table v-else class="table" data-testid="shot-table">
        <thead>
          <tr>
            <th>镜号</th>
            <th>场景</th>
            <th>状态</th>
            <th>帧率</th>
            <th>帧区间</th>
            <th>帧条目</th>
            <th>预计时长</th>
            <th>完成度</th>
            <th>负责人</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.shot.id">
            <td class="mono">{{ row.shot.code }}</td>
            <td>{{ row.shot.sceneName }}</td>
            <td><StatusTag :status="row.shot.status" size="small" /></td>
            <td>{{ row.shot.fps }} fps</td>
            <td class="mono">{{ row.shot.startFrame }} – {{ row.shot.endFrame }}</td>
            <td>{{ row.frameCount }}</td>
            <td>{{ row.duration }} s</td>
            <td class="progress-cell">
              <ShotProgress
                compact
                :planned="row.summary?.planned ?? 0"
                :taken="row.summary?.taken ?? 0"
                :wasted="row.summary?.wasted ?? 0"
                :remaining="row.summary?.remaining ?? 0"
                :percent="row.summary?.percent ?? 0"
              />
            </td>
            <td>{{ row.shot.owner || '未指派' }}</td>
            <td>
              <button type="button" class="btn small" @click="goDetail(row.shot.id)">查看详情</button>
            </td>
          </tr>
        </tbody>
      </table>

      <p v-if="rows.length" class="muted footer-note">
        最近更新：{{ formatDateTime(Math.max(...shots.map((s) => s.updatedAt || 0))) }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
}
h1 {
  margin: 0;
  font-size: 22px;
}
.sub {
  margin: 4px 0 0;
  color: #6b7686;
  font-size: 13px;
}
.head-actions {
  display: flex;
  gap: 10px;
}
.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}
.stat {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat .label {
  font-size: 12px;
  color: #6b7686;
}
.stat .value {
  font-size: 24px;
  font-weight: 700;
  color: #1f2d3d;
}
.stat .hint {
  font-size: 12px;
  color: #8a94a6;
}
.panel {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 16px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.panel-head h2 {
  margin: 0;
  font-size: 16px;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th,
.table td {
  text-align: left;
  padding: 10px 8px;
  border-bottom: 1px solid #eef1f6;
  vertical-align: middle;
}
.table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.progress-cell {
  min-width: 210px;
}
.day-block {
  border: 1px solid #e2e7ef;
  border-radius: 8px;
  margin-bottom: 14px;
  overflow: hidden;
}
.day-block.unscheduled {
  border-style: dashed;
  background: #fbfcfe;
}
.day-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  background: #f6f8fc;
  border-bottom: 1px solid #e2e7ef;
}
.day-block.unscheduled .day-head {
  background: #f2f4f8;
}
.day-title {
  font-weight: 600;
  font-size: 14px;
  color: #1f2d3d;
}
.day-block .table th:first-child,
.day-block .table td:first-child {
  padding-left: 12px;
}
.order-col {
  width: 56px;
}
.date-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.date-input {
  height: 28px;
  padding: 0 8px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  font-size: 12px;
  color: #1f2d3d;
  background: #fff;
}
.date-input:disabled {
  background: #f0f2f6;
  color: #8a94a6;
  cursor: not-allowed;
}
.order-btns {
  display: flex;
  gap: 6px;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.empty-line {
  margin: 0;
  padding: 14px 12px;
}
.lock-hint {
  margin-left: 8px;
}
.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 13px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.small {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}
.footer-note {
  margin: 10px 0 0;
}
</style>
