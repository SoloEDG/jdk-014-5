<script setup lang="ts">
import {
  GitBranch,
  Download,
  Upload,
  Undo2,
  HardDriveDownload,
  Split,
  TriangleAlert,
} from "lucide-vue-next";
defineProps<{
  busy: boolean;
  status: string;
  canUndo: boolean;
  saveFailed: boolean;
}>();
const emit = defineEmits<{
  export: [];
  import: [file: File];
  undo: [];
  download: [];
  demo: [];
}>();
function selected(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) emit("import", file);
  input.value = "";
}
</script>
<template>
  <div class="sync-panel">
    <div class="section-heading">
      <span><GitBranch :size="14" /> 作品同步 <small>离线可用</small></span>
    </div>
    <div class="sync-actions">
      <button class="sync-button" :disabled="busy" @click="emit('export')">
        <Download :size="14" /> 导出作品文件
      </button>
      <label class="sync-button accent" :class="{ disabled: busy }">
        <Upload :size="14" /> {{ busy ? "正在解析…" : "导入并合并" }}
        <input
          aria-label="导入作品文件"
          type="file"
          accept=".json,application/json"
          :disabled="busy"
          @change="selected"
        />
      </label>
    </div>
    <button class="subtle-button" title="生成一个模拟另一台电脑修改的文件" @click="emit('demo')">
      <Split :size="13" /> 生成分支文件体验合并
    </button>
    <p v-if="saveFailed" class="save-failed" role="alert">
      <TriangleAlert :size="13" /> 本地存储失败：合并结果仅保留在当前页面。
      <button @click="emit('download')">
        <HardDriveDownload :size="13" /> 下载合并结果
      </button>
    </p>
    <button v-if="canUndo" class="undo-button" @click="emit('undo')">
      <Undo2 :size="13" /> 撤回上次合并
    </button>
    <p v-if="status" class="notice" role="status">{{ status }}</p>
  </div>
</template>
