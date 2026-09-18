/** Home tab, Podcast tab and episodes: fills in with Task 3a. */
export const en = {
  // Home screen chrome
  'home.searchAccessibilityLabel': 'Search islands',
  'home.recordAccessibilityLabel': 'Record a new island',
  'home.notConfigured': 'Set EXPO_PUBLIC_SHADOW_API_URL and EXPO_PUBLIC_SHADOW_TOKEN in .env, then restart the dev server.',
  'home.serverUnreachable': 'Could not reach the server',
  'home.serverNoAnswer': 'The server did not answer.',

  // Sort row
  'home.sortNewest': 'Newest',
  'home.sortLeastPracticed': 'Least practiced',

  // Empty and error states
  'home.noIslandMatches': 'No island matches',
  'home.noIslandsYet': 'No islands yet. Record a minute about your day and one gets built from it.',

  // Island card
  'home.untitledIsland': 'Untitled island',
  'home.failed': 'Failed',
  'home.dueToday': 'Due today',
  // Base keys exist only so `t('home.lines', { count })` type-checks: the
  // plural suffix always wins at runtime once `count` is passed (see
  // `pluralSuffix` in `src/lib/i18n.ts`).
  'home.lines': '{count} lines',
  'home.lines_one': '{count} line',
  'home.lines_two': '{count} lines',
  'home.lines_other': '{count} lines',
  'home.minutes': '{count} min',
  'home.minutes_one': '{count} min',
  'home.minutes_two': '{count} min',
  'home.minutes_other': '{count} min',
  'home.keptUp': 'kept up {kept}/{total}',
  'home.complexitySimple': 'simple',
  'home.complexityComplex': 'complex',

  // Rename/delete sheet
  'home.deleteConfirmTitle': 'Delete "{title}"?',
  'home.deleteConfirmBody': 'The recording, its lines and their audio are removed. This cannot be undone.',
  'home.deleteFailedTitle': 'Could not delete',
  'home.renameFailedTitle': 'Could not rename',
  'home.save': 'Save',
  'home.rename': 'Rename',
  'home.deleteIsland': 'Delete island',

  // Practice card
  'home.practiceToday': 'Today',
  'home.practiceStreak': 'Streak',
  'home.practiceGoal': 'of {goal}',

  // Island search
  'home.searchPlaceholder': 'Search islands',
  'home.closeSearchAccessibilityLabel': 'Close search',

  // Podcast tab
  'home.podcastSearchPlaceholder': 'Search podcast or URL',
  'home.podcastCatalogError': 'The catalog could not be loaded.',
  'home.podcastSearchError': 'That could not be searched.',
  'home.podcastNoShowsFound': 'No shows found.',
  'home.podcastLevelBeginner': 'Beginner',
  'home.podcastLevelIntermediate': 'Intermediate',
  'home.podcastLevelAdvanced': 'Advanced',
  'home.podcastViewAll': 'View all {count}',

  // Podcast episodes
  'home.episodesTitle': 'Episodes',
  'home.episodesFeedError': 'The feed could not be loaded.',
  'home.episodeFallbackTitle': 'Podcast episode',
  'home.untitledEpisode': 'Untitled episode',
};
