"""Check only the repository's generated synthetic PDF fixture, not live documents."""
import json
import re
from pathlib import Path
import pdfplumber

target = Path('output/pdf/export-layout-acceptance.pdf')
violations = []
texts = []
characters = 0
with pdfplumber.open(target) as pdf:
    for index, page in enumerate(pdf.pages, 1):
        texts.append(page.extract_text() or '')
        for char in page.chars:
            characters += 1
            if (char['x0'] < 38 or char['x1'] > page.width - 38
                    or char['top'] < 28 or char['bottom'] > page.height - 18):
                violations.append({'page': index, 'text': char['text'],
                                   'bounds': [char[k] for k in ('x0', 'x1', 'top', 'bottom')]})
    compact = re.sub(r'\s+', '', ' '.join(texts).replace('\u200b', ''))
    result = {'pages': len(pdf.pages), 'characters': characters,
              'marginViolations': violations,
              'titlePresent': 'HolySheet-exportacceptance' in compact,
              'finalParagraphPresent': 'Thefinaltextremainsvisibleafterthetableandacrosspagebreaks.' in compact,
              'sourceVersionPresent': 'Savedversion42' in compact}
target.with_name('export-layout-check.json').write_text(json.dumps(result, indent=2))
assert result['pages'] >= 3, result
assert characters >= 8000, result
assert not violations, result
assert result['titlePresent'] and result['finalParagraphPresent'] and result['sourceVersionPresent'], result
print(json.dumps({k: v for k, v in result.items() if k != 'marginViolations'}))
