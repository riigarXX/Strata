<script setup lang="ts">
import { usePreferencesStore } from '../features/preferences'
import { WorkspaceShell } from '../features/workspace'

// El tema no se aplica aquí: main lo fija en `nativeTheme.themeSource` y `prefers-color-scheme` lo sigue.
void usePreferencesStore().load()
</script>

<template>
  <WorkspaceShell />
</template>
