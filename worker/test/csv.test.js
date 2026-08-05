import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCSV,
  normalizeHeaderName,
  findRadioIdIndex,
  isThaiRadioId,
  filterDedupeSortThai,
  buildCSV,
  looksLikeHtml,
} from '../src/index.js';

describe('parseCSV', () => {
  test('parses simple comma-separated rows', () => {
    const { headers, rows } = parseCSV('RADIO_ID,CALLSIGN\n5201234,HS1ABC\n5205678,HS2XYZ\n');
    assert.deepEqual(headers, ['RADIO_ID', 'CALLSIGN']);
    assert.deepEqual(rows, [
      ['5201234', 'HS1ABC'],
      ['5205678', 'HS2XYZ'],
    ]);
  });

  test('handles commas inside quoted fields', () => {
    const { headers, rows } = parseCSV(
      'RADIO_ID,CALLSIGN,REMARKS\n5201234,HS1ABC,"Bangkok, Thailand"\n',
    );
    assert.deepEqual(headers, ['RADIO_ID', 'CALLSIGN', 'REMARKS']);
    assert.deepEqual(rows, [['5201234', 'HS1ABC', 'Bangkok, Thailand']]);
  });

  test('handles doubled double-quote escaping inside quoted fields', () => {
    const { rows } = parseCSV('RADIO_ID,REMARKS\n5201234,"Say ""Hello"" there"\n');
    assert.deepEqual(rows, [['5201234', 'Say "Hello" there']]);
  });

  test('handles CRLF line endings', () => {
    const { headers, rows } = parseCSV('RADIO_ID,CALLSIGN\r\n5201234,HS1ABC\r\n5205678,HS2XYZ\r\n');
    assert.deepEqual(headers, ['RADIO_ID', 'CALLSIGN']);
    assert.equal(rows.length, 2);
  });

  test('handles bare LF line endings', () => {
    const { rows } = parseCSV('RADIO_ID,CALLSIGN\n5201234,HS1ABC\n');
    assert.equal(rows.length, 1);
  });

  test('handles a mix of CRLF and LF in the same document', () => {
    const { rows } = parseCSV('RADIO_ID,CALLSIGN\r\n5201234,HS1ABC\n5205678,HS2XYZ\r\n');
    assert.equal(rows.length, 2);
  });

  test('strips a leading UTF-8 BOM before parsing headers', () => {
    const { headers } = parseCSV('﻿RADIO_ID,CALLSIGN\n5201234,HS1ABC\n');
    assert.equal(headers[0], 'RADIO_ID');
  });

  test('preserves empty fields', () => {
    const { rows } = parseCSV('RADIO_ID,CALLSIGN,CITY\n5201234,,Bangkok\n');
    assert.deepEqual(rows, [['5201234', '', 'Bangkok']]);
  });

  test('handles a quoted field containing an embedded newline', () => {
    const { rows } = parseCSV('RADIO_ID,REMARKS\n5201234,"line one\nline two"\n');
    assert.deepEqual(rows, [['5201234', 'line one\nline two']]);
  });

  test('handles a final row with no trailing newline', () => {
    const { rows } = parseCSV('RADIO_ID,CALLSIGN\n5201234,HS1ABC');
    assert.deepEqual(rows, [['5201234', 'HS1ABC']]);
  });

  test('ignores stray blank lines', () => {
    const { rows } = parseCSV('RADIO_ID,CALLSIGN\n\n5201234,HS1ABC\n\n5205678,HS2XYZ\n');
    assert.equal(rows.length, 2);
  });
});

describe('header detection', () => {
  test('normalizeHeaderName trims and upper-cases', () => {
    assert.equal(normalizeHeaderName('  radio_id  '), 'RADIO_ID');
    assert.equal(normalizeHeaderName('Radio_ID'), 'RADIO_ID');
  });

  for (const variant of ['RADIO_ID', 'radio_id', 'Radio_ID', ' RADIO_ID ']) {
    test(`finds RADIO_ID column for header spelled "${variant}"`, () => {
      const idx = findRadioIdIndex(['CALLSIGN', variant, 'CITY']);
      assert.equal(idx, 1);
    });
  }

  test('returns -1 when no RADIO_ID column exists', () => {
    assert.equal(findRadioIdIndex(['CALLSIGN', 'CITY']), -1);
  });
});

describe('isThaiRadioId', () => {
  test('accepts a purely numeric id starting with 520', () => {
    assert.equal(isThaiRadioId('5201234'), true);
  });

  test('trims surrounding whitespace before checking', () => {
    assert.equal(isThaiRadioId('  5201234  '), true);
  });

  test('rejects ids not starting with 520', () => {
    assert.equal(isThaiRadioId('1235201234'), false);
    assert.equal(isThaiRadioId('4409999'), false);
  });

  test('rejects non-numeric values even if they contain 520', () => {
    assert.equal(isThaiRadioId('520ABCD'), false);
    assert.equal(isThaiRadioId('ID-520000'), false);
  });

  test('rejects empty or null values', () => {
    assert.equal(isThaiRadioId(''), false);
    assert.equal(isThaiRadioId('   '), false);
    assert.equal(isThaiRadioId(null), false);
    assert.equal(isThaiRadioId(undefined), false);
  });
});

describe('filterDedupeSortThai', () => {
  const headers = ['RADIO_ID', 'CALLSIGN', 'CITY', 'COUNTRY'];

  test('filters to only Thai (520) records', () => {
    const rows = [
      ['5201234', 'HS1ABC', 'Bangkok', 'Thailand'],
      ['3101234', 'W1ABC', 'New York', 'United States'],
      ['5209999', 'HS9XYZ', 'Chiang Mai', 'Thailand'],
    ];
    const { rows: result } = filterDedupeSortThai(headers, rows);
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r[0].startsWith('520')));
  });

  test('does not match a "520" that only appears in another column', () => {
    const rows = [
      // RADIO_ID does not start with 520, but CITY and CALLSIGN happen to contain "520"
      ['1234567', 'HS520XY', '520 Sukhumvit Road', 'Thailand'],
    ];
    const { rows: result } = filterDedupeSortThai(headers, rows);
    assert.equal(result.length, 0);
  });

  test('does not include a record just because COUNTRY says Thailand', () => {
    const rows = [['9991234', 'HS1ABC', 'Bangkok', 'Thailand']];
    const { rows: result } = filterDedupeSortThai(headers, rows);
    assert.equal(result.length, 0);
  });

  test('includes a 520 record even when COUNTRY is missing or different', () => {
    const rows = [['5201234', 'HS1ABC', 'Unknown', '']];
    const { rows: result } = filterDedupeSortThai(headers, rows);
    assert.equal(result.length, 1);
  });

  test('removes duplicate RADIO_IDs, keeping the first occurrence, and counts them', () => {
    const rows = [
      ['5201234', 'HS1ABC-FIRST', 'Bangkok', 'Thailand'],
      ['5205555', 'HS5EFG', 'Phuket', 'Thailand'],
      ['5201234', 'HS1ABC-DUPLICATE', 'Bangkok', 'Thailand'],
    ];
    const { rows: result, duplicateCount } = filterDedupeSortThai(headers, rows);
    assert.equal(result.length, 2);
    assert.equal(duplicateCount, 1);
    const first = result.find((r) => r[0] === '5201234');
    assert.equal(first[1], 'HS1ABC-FIRST');
  });

  test('sorts results ascending by RADIO_ID numerically', () => {
    const rows = [
      ['5209999', 'C', 'X', 'Thailand'],
      ['5200001', 'A', 'X', 'Thailand'],
      ['5205000', 'B', 'X', 'Thailand'],
    ];
    const { rows: result } = filterDedupeSortThai(headers, rows);
    assert.deepEqual(
      result.map((r) => r[0]),
      ['5200001', '5205000', '5209999'],
    );
  });

  test('throws MISSING_COLUMN when there is no RADIO_ID header', () => {
    assert.throws(() => filterDedupeSortThai(['CALLSIGN', 'CITY'], [['HS1ABC', 'Bangkok']]), (err) => err.code === 'MISSING_COLUMN');
  });
});

describe('buildCSV', () => {
  test('output begins with a UTF-8 BOM so Excel opens Thai text correctly', () => {
    const csv = buildCSV(['RADIO_ID', 'CALLSIGN'], [['5201234', 'HS1ABC']]);
    assert.equal(csv.charCodeAt(0), 0xfeff);
  });

  test('preserves original headers and all columns, with no extra index column', () => {
    const headers = ['RADIO_ID', 'CALLSIGN', 'FIRST_NAME', 'CITY', 'COUNTRY'];
    const rows = [['5201234', 'HS1ABC', 'สมชาย', 'Bangkok', 'Thailand']];
    const csv = buildCSV(headers, rows);
    const withoutBom = csv.slice(1);
    const lines = withoutBom.split('\r\n').filter(Boolean);
    assert.equal(lines[0], headers.join(','));
    assert.equal(lines[0].split(',').length, headers.length);
    assert.ok(lines[1].includes('สมชาย'));
  });

  test('re-quotes fields containing commas, quotes, or newlines on output', () => {
    const csv = buildCSV(['RADIO_ID', 'REMARKS'], [['5201234', 'Bangkok, "Home" QTH']]);
    assert.ok(csv.includes('"Bangkok, ""Home"" QTH"'));
  });

  test('uses CRLF between rows', () => {
    const csv = buildCSV(['A', 'B'], [['1', '2'], ['3', '4']]);
    assert.ok(csv.includes('\r\n'));
  });
});

describe('looksLikeHtml', () => {
  test('detects an HTML doctype error page', () => {
    assert.equal(looksLikeHtml('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>'), true);
  });

  test('detects a bare <html> page', () => {
    assert.equal(looksLikeHtml('<html><head></head><body>error</body></html>'), true);
  });

  test('does not flag genuine CSV content as HTML', () => {
    assert.equal(looksLikeHtml('RADIO_ID,CALLSIGN\n5201234,HS1ABC\n'), false);
  });
});
