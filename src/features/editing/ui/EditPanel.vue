<script setup lang="ts">
import { ref, watch } from "vue";
import {
  Pencil,
  ArrowLeft,
  ArrowRight,
  Copy,
  Replace,
  Trash2,
  Save,
} from "lucide-vue-next";
import type { ComicPage, Panel } from "../../../shared/document";
import type { PanelDraft } from "../lib/operations";
const props = defineProps<{ page?: ComicPage; panel?: Panel; message: string }>();
const emit = defineEmits<{
  move: [delta: number];
  duplicate: [];
  remove: [];
  replaceImage: [file: File];
  save: [draft: PanelDraft];
}>();
const draft = ref<PanelDraft>({
  dialogue: "",
  speaker: "",
  sound: "rain",
  duration: 5,
});
watch(
  () => props.panel?.id,
  () => {
    if (props.panel)
      draft.value = {
        dialogue: props.panel.dialogue,
        speaker: props.panel.speaker,
        sound: props.panel.sound,
        duration: props.panel.duration,
      };
  },
  { immediate: true },
);
function pickImage(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) emit("replaceImage", file);
  input.value = "";
}
</script>
<template>
  <section v-if="page && panel" class="edit-panel">
    <div class="section-heading">
      <span><Pencil :size="14" /> 编辑当前页</span
      ><span class="muted">{{ page.title }}</span>
    </div>
    <div class="page-tools">
      <button title="前移一页" @click="emit('move', -1)">
        <ArrowLeft :size="13" /> 前移
      </button>
      <button title="后移一页" @click="emit('move', 1)">
        后移 <ArrowRight :size="13" />
      </button>
      <button title="复制本页" @click="emit('duplicate')">
        <Copy :size="13" /> 复制
      </button>
      <label class="replace-image" title="替换本页图片">
        <Replace :size="13" /> 换图
        <input
          aria-label="替换本页图片"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          @change="pickImage"
        />
      </label>
      <button title="删除本页" @click="emit('remove')">
        <Trash2 :size="13" /> 删除
      </button>
    </div>
    <form class="panel-form" @submit.prevent="emit('save', { ...draft })">
      <label>
        角色
        <input v-model="draft.speaker" maxlength="20" placeholder="旁白" />
      </label>
      <label>
        对白
        <textarea
          v-model="draft.dialogue"
          rows="3"
          maxlength="200"
          placeholder="这一格要说的话…"
        ></textarea>
      </label>
      <div class="panel-form-row">
        <label>
          音效
          <select v-model="draft.sound">
            <option value="rain">雨声</option>
            <option value="pulse">电波</option>
            <option value="wind">风声</option>
          </select>
        </label>
        <label>
          时长（秒）
          <input v-model.number="draft.duration" type="number" min="1" max="60" />
        </label>
      </div>
      <button class="save-panel" type="submit"><Save :size="13" /> 保存分镜</button>
    </form>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
  </section>
</template>
