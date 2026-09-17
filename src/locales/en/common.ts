/**
 * Stack and tab titles, Alert verbs, stage labels, api error codes and
 * island error codes: the strings that are not any one screen's, so every
 * other namespace can lean on them instead of repeating "Cancel" everywhere.
 */
export const en = {
  'tab.islands': 'Islands',
  'tab.podcast': 'Podcast',
  'tab.settings': 'Settings',

  'title.newIsland': 'New island',
  'title.voice': 'Voice',
  'title.playback': 'Playback',
  'title.practice': 'Practice',
  'title.data': 'Data',
  'title.about': 'About',
  'title.language': 'Language',
  'title.prismLab': 'Prism lab',

  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.ok': 'OK',
  'common.retry': 'Retry',
  'common.working': 'Working…',
  'common.loading': 'Loading',

  // Stage labels a running build cycles through. `stage.working` is the
  // fallback for a stage the client does not recognise.
  'stage.queued': 'Queued',
  'stage.transcribing': 'Transcribing',
  'stage.writing': 'Writing',
  'stage.speaking': 'Speaking',
  'stage.slicing': 'Slicing',
  'stage.extracting': 'Extracting',
  'stage.downloading': 'Downloading',
  'stage.working': 'Working…',

  // Error codes the backend sends as `detail.code` in an HTTPException.
  'api.daily_limit': "You've reached today's limit of {limit}.",
  'api.voice_unreachable': 'The voice engine is unreachable.',
  'api.file_too_large': 'That file is too large to import.',
  'api.recording_too_large': 'That recording is too large.',
  'api.audio_undecodable': 'That audio could not be decoded.',
  'api.empty_upload': 'That upload was empty.',

  // Error codes an island can be marked failed with (`store.set_failed`'s `code`).
  'islandError.import_interrupted': 'Import was interrupted.',
  'islandError.build_interrupted': 'Build was interrupted.',
  'islandError.transcribe_empty': 'Nothing was transcribed.',
  'islandError.no_lines': 'No lines were found.',
  'islandError.voice_no_audio': 'The voice produced no audio.',
  'islandError.audio_undecodable': 'The audio could not be decoded.',
  'islandError.no_line_cut': 'No line could be cut.',
  'islandError.media_undecodable': 'The media could not be decoded.',
  'islandError.media_no_audio': 'The media has no audio.',
  'islandError.start_past_end': 'The start time is past the end.',
  'islandError.whisper_no_timings': 'Transcription returned no timings.',
  'islandError.no_subtitles_in_range': 'No subtitles were found in that range.',
  'islandError.episode_download_failed': 'The episode failed to download.',
  'islandError.unknown': 'Something went wrong.',
};
