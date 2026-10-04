/**
 * 기상청's 중기예보 bodies, as the public data portal answered them on 2026-10-04 (`MidFcstInfoService`,
 * 서울 `11B10101` for the temperatures, 서울·인천·경기 `11B00000` for the land forecast). Byte for byte
 * what came back, with nothing of the key in them — the service never echoes it.
 *
 * The 06:00 issuance begins at day four and the 18:00 one at day five; days four to seven are a
 * morning and an afternoon each, days eight to ten one value a day. `taMin5Low`/`High` are the
 * service's uncertainty bands, which nothing here reads.
 */

/** `getMidTa`, 2026-10-04 06:00: days four to ten. */
export const MID_TEMPERATURE_0600 =
  '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"},"body":{"dataType":"JSON","items":{"item":[{"regId":"11B10101","taMin4":10,"taMin4Low":1,"taMin4High":1,"taMax4":25,"taMax4Low":1,"taMax4High":1,"taMin5":11,"taMin5Low":1,"taMin5High":1,"taMax5":25,"taMax5Low":1,"taMax5High":1,"taMin6":13,"taMin6Low":1,"taMin6High":1,"taMax6":25,"taMax6Low":1,"taMax6High":1,"taMin7":14,"taMin7Low":1,"taMin7High":1,"taMax7":26,"taMax7Low":1,"taMax7High":1,"taMin8":14,"taMin8Low":0,"taMin8High":2,"taMax8":25,"taMax8Low":0,"taMax8High":2,"taMin9":14,"taMin9Low":0,"taMin9High":2,"taMax9":22,"taMax9Low":0,"taMax9High":2,"taMin10":11,"taMin10Low":0,"taMin10High":3,"taMax10":21,"taMax10Low":0,"taMax10High":3}]},"pageNo":1,"numOfRows":10,"totalCount":1}}}';
/** `getMidTa`, 2026-10-04 18:00: days five to ten. */
export const MID_TEMPERATURE_1800 =
  '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"},"body":{"dataType":"JSON","items":{"item":[{"regId":"11B10101","taMin5":11,"taMin5Low":1,"taMin5High":1,"taMax5":25,"taMax5Low":1,"taMax5High":1,"taMin6":13,"taMin6Low":1,"taMin6High":1,"taMax6":25,"taMax6Low":1,"taMax6High":1,"taMin7":14,"taMin7Low":1,"taMin7High":1,"taMax7":26,"taMax7Low":1,"taMax7High":1,"taMin8":14,"taMin8Low":0,"taMin8High":2,"taMax8":25,"taMax8Low":0,"taMax8High":2,"taMin9":14,"taMin9Low":0,"taMin9High":2,"taMax9":22,"taMax9Low":0,"taMax9High":2,"taMin10":11,"taMin10Low":0,"taMin10High":3,"taMax10":21,"taMax10Low":0,"taMax10High":3}]},"pageNo":1,"numOfRows":10,"totalCount":1}}}';
/** `getMidLandFcst`, 2026-10-04 06:00. */
export const MID_LAND_0600 =
  '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"},"body":{"dataType":"JSON","items":{"item":[{"regId":"11B00000","rnSt4Am":10,"rnSt4Pm":10,"rnSt5Am":10,"rnSt5Pm":10,"rnSt6Am":10,"rnSt6Pm":10,"rnSt7Am":10,"rnSt7Pm":10,"rnSt8":20,"rnSt9":20,"rnSt10":20,"wf4Am":"맑음","wf4Pm":"맑음","wf5Am":"맑음","wf5Pm":"맑음","wf6Am":"맑음","wf6Pm":"맑음","wf7Am":"맑음","wf7Pm":"맑음","wf8":"구름많음","wf9":"구름많음","wf10":"구름많음"}]},"pageNo":1,"numOfRows":10,"totalCount":1}}}';
/** `getMidLandFcst`, 2026-10-04 18:00. */
export const MID_LAND_1800 =
  '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"},"body":{"dataType":"JSON","items":{"item":[{"regId":"11B00000","rnSt5Am":10,"rnSt5Pm":10,"rnSt6Am":10,"rnSt6Pm":10,"rnSt7Am":10,"rnSt7Pm":10,"rnSt8":20,"rnSt9":30,"rnSt10":20,"wf5Am":"맑음","wf5Pm":"맑음","wf6Am":"맑음","wf6Pm":"맑음","wf7Am":"맑음","wf7Pm":"맑음","wf8":"구름많음","wf9":"흐림","wf10":"구름많음"}]},"pageNo":1,"numOfRows":10,"totalCount":1}}}';
/** A region the service no longer issues (`11H10603` 군위, a district of 대구 since 2023): NO_DATA, with HTTP 200. */
export const MID_NO_DATA =
  '{"response":{"header":{"resultCode":"03","resultMsg":"NO_DATA"}}}';
/**
 * A key the service does not know, HTTP 403 — the gateway's envelope, not the service's, and the one
 * every VM holding only the 나라장터 key gets here until the fleet's key is replaced.
 */
export const MID_KEY_NOT_REGISTERED =
  '{"OpenAPI_ServiceResponse":{"cmmMsgHeader":{"errMsg":"SERVICE_KEY_IS_NOT_REGISTERED_ERROR","returnAuthMsg":"등록되지 않은 서비스키","returnReasonCode":"30"}}}';
