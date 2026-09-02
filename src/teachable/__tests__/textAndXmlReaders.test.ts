import { describe, expect, it } from 'vitest'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { coreGraphOperatorImplementationsV1 } from '../operators/coreGraphOperators'
import { decodeTextTableV1 } from '../operators/textTable'
import { decodeXmlRecordsV1 } from '../operators/xmlRecords'

const context = (files: Record<string, string>) => ({ read: async (path: string) => new TextEncoder().encode(files[path]!) } as never)

describe('text.table reader', () => {
  it('reads KITTI-style key-value calibration into one row of numeric arrays', () => {
    const text = 'calib_time: 09-Jan-2012 13:57:47\nS_00: 1.392000e+03 5.120000e+02\nP_rect_00: 7.215377e+02 0.000000e+00 6.095593e+02 0.000000e+00\n'
    expect(decodeTextTableV1(text, { layout: 'key-values' })).toEqual([{
      calib_time: ['09-Jan-2012', '13:57:47'], S_00: [1392, 512], P_rect_00: [721.5377, 0, 609.5593, 0],
    }])
  })

  it('reads whitespace-delimited rows with named columns and line lists with an index', () => {
    const oxts = '49.01 8.43 116.4 0.02 0.01 -1.5\n49.02 8.44 116.5 0.02 0.01 -1.6\n'
    expect(decodeTextTableV1(oxts, { layout: 'delimited', columns: ['lat', 'lon', 'alt', 'roll', 'pitch', 'yaw'] })).toEqual([
      { lat: 49.01, lon: 8.43, alt: 116.4, roll: 0.02, pitch: 0.01, yaw: -1.5 },
      { lat: 49.02, lon: 8.44, alt: 116.5, roll: 0.02, pitch: 0.01, yaw: -1.6 },
    ])
    expect(decodeTextTableV1('a,b\n1,2\n3,4\n', { layout: 'delimited', delimiter: ',', header: true })).toEqual([{ a: 1, b: 2 }, { a: 3, b: 4 }])
    expect(decodeTextTableV1('2011-09-26 13:02:25.964\n2011-09-26 13:02:26.067\n', { layout: 'lines', field: 'stamp', indexField: 'frame' }))
      .toEqual([{ stamp: '2011-09-26 13:02:25.964', frame: 0 }, { stamp: '2011-09-26 13:02:26.067', frame: 1 }])
    expect(() => decodeTextTableV1('1 2\n3 4\n', { layout: 'delimited', maxRows: 1 })).toThrow(/maxRows/u)
  })

  it('stamps the source path on every row through the operator', async () => {
    const read = coreGraphOperatorImplementationsV1['text.table']!
    const result = await read({ files: [{ path: 'oxts/data/0000000000.txt', size: 1 }, { path: 'oxts/data/0000000001.txt', size: 1 }] },
      { layout: 'delimited', columns: ['lat', 'lon'], pathField: 'path' },
      context({ 'oxts/data/0000000000.txt': '1 2\n', 'oxts/data/0000000001.txt': '3 4\n' }))
    expect((result.rows as { rows: unknown[] }).rows).toEqual([{ lat: 1, lon: 2, path: 'oxts/data/0000000000.txt' }, { lat: 3, lon: 4, path: 'oxts/data/0000000001.txt' }])
  })
})

describe('xml.records reader', () => {
  const tracklets = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE boost_serialization>
<boost_serialization signature="serialization::archive" version="9">
<tracklets class_id="0" tracking_level="0" version="0">
  <count>2</count>
  <item_version>1</item_version>
  <item class_id="1">
    <objectType>Car</objectType>
    <h>1.50</h><w>1.60</w><l>3.90</l>
    <first_frame>0</first_frame>
    <poses class_id="2"><count>2</count><item><tx>1.5</tx><ty>-2.0</ty><tz>-1.0</tz><rz>0.1</rz></item><item><tx>1.6</tx><ty>-2.1</ty><tz>-1.0</tz><rz>0.1</rz></item></poses>
    <finished>1</finished>
  </item>
  <item class_id="1">
    <objectType>Pedestrian &amp; child</objectType>
    <h>1.7</h><w>0.6</w><l>0.8</l>
    <first_frame>3</first_frame>
    <poses><count>1</count><item><tx>5</tx><ty>1</ty><tz>-1</tz><rz>0</rz></item></poses>
    <finished>1</finished>
  </item>
</tracklets>
</boost_serialization>`

  it('selects repeated elements as records with nested children, arrays, attributes, and entities', () => {
    const rows = decodeXmlRecordsV1(tracklets, { recordPath: 'boost_serialization/tracklets/item' })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ '@class_id': 1, objectType: 'Car', h: 1.5, w: 1.6, l: 3.9, first_frame: 0, finished: 1 })
    expect((rows[0]!.poses as { item: unknown[] }).item).toEqual([{ tx: 1.5, ty: -2, tz: -1, rz: 0.1 }, { tx: 1.6, ty: -2.1, tz: -1, rz: 0.1 }])
    expect(rows[1]).toMatchObject({ objectType: 'Pedestrian & child', first_frame: 3 })
    // a single nested item is a record, not a one-element array
    expect((rows[1]!.poses as { item: unknown }).item).toEqual({ tx: 5, ty: 1, tz: -1, rz: 0 })
  })

  it('rejects malformed documents and empty paths', () => {
    expect(() => decodeXmlRecordsV1('<a><b></a>', { recordPath: 'a/b' })).toThrow(/XML_MALFORMED/u)
    expect(() => decodeXmlRecordsV1('<a/>', { recordPath: ' / ' })).toThrow(/recordPath/u)
    expect(decodeXmlRecordsV1('<a><b x="1"/><b x="2"/></a>', { recordPath: 'a/b' })).toEqual([{ '@x': 1 }, { '@x': 2 }])
  })

  it('publishes both readers through the public contract', () => {
    const names = bundledPhase2OperatorRegistry.list().map((operator) => operator.name)
    expect(names).toEqual(expect.arrayContaining(['text.table', 'xml.records']))
  })
})
