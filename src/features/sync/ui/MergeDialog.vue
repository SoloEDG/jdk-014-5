<script setup lang="ts">
import { computed, ref } from "vue";
import {
  X,
  Info,
  BookOpen,
  Image,
  Scan,
  ArrowUpDown,
  Bookmark,
  Link2,
  TriangleAlert,
  GitMerge,
} from "lucide-vue-next";
import type { MergeGroup } from "../model/sync";
import type { MergeItem } from "../lib/diff";
const props = defineProps<{
  groups: MergeGroup[];
  decisions: Record<string, string>;
  costText: string;
  warnings: string[];
  unresolved: number;
}>();
const emit = defineEmits<{
  decide: [key: string, value: string];
  decideGroup: [group: string, value: string];
  decideAll: [value: string];
  apply: [];
  cancel: [];
}>();
const ICONS = {
  meta: Info,
  chapter: BookOpen,
  page: Image,
  panel: Scan,
  order: ArrowUpDown,
  bookmark: Bookmark,
  link: Link2,
};
const onlyConflicts = ref(false);
const visibleGroups = computed(() => {
  if (!onlyConflicts.value) return props.groups;
  return props.groups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => i.tone === "conflict"),
    }))
    .filter((g) => g.items.length);
});
const conflictTotal = computed(
  () =>
    props.groups.reduce(
      (n, g) => n + g.items.filter((i) => i.tone === "conflict").length,
      0,
    ),
);
function iconFor(item: MergeItem) {
  return ICONS[item.kind] ?? Info;
}
</script>
<template>
  <div class="merge-overlay" @click.self="emit('cancel')">
    <div class="merge-dialog" role="dialog" aria-label="合并作品文件">
      <header class="merge-header">
        <div>
          <h2><GitMerge :size="16" /> 合并作品文件</h2>
          <p>
            对照共同起点对比了两台电脑的修改<template v-if="conflictTotal"
              >，<b>{{ conflictTotal }}</b> 处需要你做决定</template
            >
          </p>
        </div>
        <button aria-label="关闭" @click="emit('cancel')"><X :size="17" /></button>
      </header>
      <div v-if="warnings.length" class="merge-warnings">
        <p v-for="w in warnings" :key="w"><TriangleAlert :size="12" /> {{ w }}</p>
      </div>
      <div class="merge-toolbar">
        <div class="bulk-actions">
          快速选择：
          <button @click="emit('decideAll', 'auto')">全部自动</button>
          <button @click="emit('decideAll', 'local')">全部用我的</button>
          <button @click="emit('decideAll', 'incoming')">全部用对方的</button>
        </div>
        <label class="conflict-filter">
          <input v-model="onlyConflicts" type="checkbox" /> 只看冲突
        </label>
      </div>
      <div class="merge-body">
        <section v-for="group in visibleGroups" :key="group.key" class="merge-group">
          <h3>
            <span>{{ group.title }}</span>
            <span v-if="group.isChapter" class="group-bulk">
              <button @click="emit('decideGroup', group.key, 'auto')">自动</button>
              <button @click="emit('decideGroup', group.key, 'local')">本章用我的</button>
              <button @click="emit('decideGroup', group.key, 'incoming')">
                本章用对方的
              </button>
            </span>
          </h3>
          <div
            v-for="item in group.items"
            :key="item.key"
            class="merge-item"
            :class="[item.tone, { chosen: !!decisions[item.key] }]"
          >
            <component :is="iconFor(item)" :size="13" class="item-icon" />
            <div class="item-main">
              <div class="item-label">
                {{ item.label }}
                <span v-if="item.path.length > 1" class="item-path">{{
                  item.path.slice(0, -1).join(" / ")
                }}</span>
              </div>
              <div class="item-detail">{{ item.detail }}</div>
            </div>
            <div v-if="item.options.length" class="item-choices">
              <button
                v-for="opt in item.options"
                :key="opt.value"
                :class="{ active: decisions[item.key] === opt.value }"
                @click="emit('decide', item.key, opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
        </section>
        <p v-if="!visibleGroups.length" class="merge-empty">没有冲突，全部可以自动合并</p>
      </div>
      <footer class="merge-footer">
        <div class="merge-cost">
          <span>{{ costText }}</span>
          <span v-if="unresolved" class="unresolved">
            还有 {{ unresolved }} 处冲突未选择
          </span>
        </div>
        <div class="merge-actions">
          <button class="cancel" @click="emit('cancel')">取消</button>
          <button class="apply" :disabled="unresolved > 0" @click="emit('apply')">
            应用合并
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>
