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
  'title.catLab': 'Cat lab',

  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.ok': 'OK',
  'common.retry': 'Retry',
  'common.working': 'Working…',
  'common.loading': 'Loading',

  // Stage labels a running build cycles through. `stage.working` is the
  // fallback for a stage the client does not recognise. The build screens
  // strip the trailing ellipsis for the cat loader's own label; Home's busy
  // card keeps it, so every stage but the last one carries it.
  'stage.queued': 'Queued…',
  'stage.transcribing': 'Transcribing…',
  'stage.writing': 'Writing…',
  'stage.speaking': 'Speaking…',
  'stage.slicing': 'Slicing…',
  'stage.extracting': 'Extracting…',
  'stage.downloading': 'Downloading…',
  'stage.working': 'Working…',
  'stage.ready': 'Ready.',

  // Error codes the backend sends as `detail.code` in an HTTPException.
  'api.unreachable': 'The server is not reachable right now. Try again in a moment.',
  'api.daily_limit_any': 'You have reached today\u2019s limit. Try again tomorrow.',
  'api.daily_limit': "You've reached today's limit of {limit}.",
  'api.voice_unreachable': 'The voice engine is unreachable.',
  'api.file_too_large': 'That file is too large to import.',
  'api.username_taken': 'That username is taken.',
  'api.username_invalid': 'Use 3-20 letters, numbers or underscores.',
  'api.recording_too_large': 'That recording is too large.',
  'api.audio_undecodable': 'That audio could not be decoded.',
  'api.empty_upload': 'That upload was empty.',
  'api.too_long': 'That is too long. Keep it under {limit} characters.',
  'api.no_episode': 'This episode has no audio to play yet.',
  'api.not_video': 'This island is not a video.',
  'api.align_busy': 'The video audio is still being matched.',
  'api.align_closed': 'This video cannot be matched again.',
  'api.profile_not_found': 'That profile does not exist.',
  // Any other failed request: the status code says which.
  'api.requestFailed': 'Request failed ({status})',
  'api.level_locked': 'Reach level {level_req} to get that.',
  'api.not_enough_coins': 'Not enough coins for that.',
  'api.not_owned': 'You do not own that yet.',
  'api.unknown_item': 'That item no longer exists.',
  'api.freeze_cap': 'You already hold the most freezes you can.',
  // Developer error: the client always sends a well-formed id.
  'api.bad_purchase_id': 'That purchase id is not valid.',

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

  'api.account_delete_unavailable': 'Account deletion is not set up on the server yet.',
  'api.account_delete_failed': 'The account could not be deleted. Try again later.',
  'update.title': 'A new version is ready',
  'update.body.ios': 'Update Echo Tail in TestFlight to keep using the app.',
  'update.body.android': 'Download the newest version to keep using the app.',
  'update.button.ios': 'Open TestFlight',
  'update.button.android': 'Download update',
  'error.title': 'Something went wrong',
  'error.retry': 'Try again',
};
