/** Island player screen (`src/app/island/[id].tsx`): its own strings, split
 * out from `player.ts` (the tide components and sheets) because the screen
 * alone holds about 60 of them. */
export const en = {
  'player.lineOfTotal': 'Line {index} of {total}',
  'player.back': 'Back',
  'player.retryLabel': 'Retry',
  'player.regenerateLabel': 'Regenerate',
  'player.refreshLabel': 'Refresh',
  'player.stillBuildingThisIsland': 'Still building this island',
  'player.reVoicing': 'Re-voicing',
  'player.reVoicingFailed': 'Re-voicing failed',
  'player.reVoicingTakingLong': 'Re-voicing is taking longer than expected. Retry to check again.',
  'player.couldNotLoadIsland': 'Could not load this island',
  'player.untitledIsland': 'Untitled island',
  'player.couldNotRename': 'Could not rename',
  'player.serverDidNotAnswer': 'The server did not answer.',
  'player.regenerateComplexTitle': 'Regenerate with complex patterns?',
  'player.regenerateSimpleTitle': 'Regenerate one sentence at a time?',
  'player.regenerateBody': 'The current lines are replaced with new ones written from the same recording. This takes about a minute.',
  'player.regenerateFailed': 'Regenerating failed',
  'player.stillBuildingShowsWhatServerHas': 'Still building. This shows what the server has so far.',
  'player.deleteIslandTitle': 'Delete "{title}"?',
  'player.deleteIslandBody': 'Its lines, audio and takes are removed.',
  'player.couldNotDelete': 'Could not delete',
  'player.couldNotRegenerate': 'Could not regenerate',
  'player.chosenVoice': 'the chosen voice',
  'player.toolbarSpeed': 'Speed',
  'player.toolbarRepeat': 'Repeat',
  'player.toolbarReading': 'Reading',
  'player.toolbarBlind': 'Blind',
  'player.blindBoth': 'Both',
  'player.blindOff': 'Off',
  'player.keptUpWords': 'Kept up with {kept} of {total} words',
  // The strip holds the translation into whatever language the learner
  // understands, so the label never names one.
  'player.translationHidden': 'Translation, hidden',
};
