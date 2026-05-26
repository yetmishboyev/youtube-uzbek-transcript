#!/usr/bin/env python3
"""
Whisper orqali audio faylni transkriptsiya qilish.
Faqat JSON stdout ga chiqariladi (boshqa barcha chiqish stderr ga).
"""
import sys
import os
import json
import contextlib

def transcribe(audio_path, model_name='small'):
    import whisper

    if not os.path.exists(audio_path):
        print(json.dumps({'error': f'Fayl topilmadi: {audio_path}'}))
        sys.exit(1)

    model = whisper.load_model(model_name)

    # Whisper'ning barcha print/log chiqishlarini stderr ga yo'naltiramiz
    # Faqat bizning print(json.dumps(...)) stdout ga boradi
    with contextlib.redirect_stdout(sys.stderr):
        result = model.transcribe(audio_path, verbose=False, fp16=False)

    segments = []
    for seg in result.get('segments', []):
        text = seg['text'].strip()
        if text:
            segments.append({
                'offset': int(seg['start'] * 1000),
                'duration': int((seg['end'] - seg['start']) * 1000),
                'text': text,
            })

    # Faqat shu JSON stdout ga chiqadi
    print(json.dumps({
        'segments': segments,
        'language': result.get('language', 'unknown'),
    }))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': "Audio fayl yo'li kerak"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else 'small'
    transcribe(audio_path, model_name)
