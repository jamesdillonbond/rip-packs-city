#!/usr/bin/env node
/**
 * fetch-allday-collection.mjs
 * 
 * Fetches ALL moments from nflallday.com GQL API using your browser session,
 * then updates wallet_moments_cache in Supabase with real editionID + serialNumber.
 * 
 * Usage:
 *   $env:NEXT_PUBLIC_SUPABASE_URL="https://bxcqstmqfzmuolpuynti.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="YOUR_KEY"; node scripts/fetch-allday-collection.mjs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing env vars'); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const AD_COLLECTION_ID = 'dee28451-5d62-409e-a1ad-a83f763ac070';

// ── Paste your cookies and token here (from the cURL) ──
const COOKIES = `ajs_anonymous_id=0a181210-6be7-4b59-8862-b2338dd100d9; _fbp=fb.1.1774758236693.571959079287609975; singular_device_id=27fa1fb5-f8dd-48f3-b08c-1d93ac1db814; ajs_user_id=google-oauth2|108942267116026679105; _hjSessionUser_3863073=eyJpZCI6ImNkODQzN2RiLTQ1MmMtNTMwZi1hNzVhLTVhODhhNzg5YWU4OCIsImNyZWF0ZWQiOjE3NzQ3NTgyMzY2NDAsImV4aXN0aW5nIjp0cnVlfQ==; OptanonAlertBoxClosed=2026-03-29T04:24:19.034Z; cf_clearance=Bx0mmPD4fjXQh5M1FrzHEWT9H5vfi3_qfQ9DHmA6Sgg-1776034101-1.2.1.1-InxiC9uAHhw02kCUdragt1UoyiAPDlbnuB._WsV4duMxs7fezvTgvuhoybxt1SypM6eLRKUUnYQHCHQflyngud_uTHr59ataFAnlVAo6xmwRC4x_UgR.BZWFBt37inmOZ2rv8IEvKearCt0uP0BKX4nbpCR8RRwXNkLiJHhph.sGKZihZgDX.VuoJYxsTg6xPhTTCxMhR7LYuzirw6xStaljD_2JgLvERt6DxeeTwEs4MAi5Y9aOQVEwsppRwhp5xYx1xqlprIW9Lgeopy7obb0ZYkj9JxrNZgJp44WPDO6Uz61wOVE.cBPag2C1i2M8OCnM2na0Ap1SFmqhD06EcQ; nfl_session.0=eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwiaWF0IjoxNzc0NzU4MjM3LCJ1YXQiOjE3NzYwMzUyOTEsImV4cCI6MTc3ODYyNzI5MX0..kklzf6b0VZgRlqI-.Ip6RwXTtTYANpcJqkZIbAINihnQm5olcbbq8HGSd4mc5LcF8EtL0e06fJ1fQeFWLUPStQliBS82HK9kS72BRa55UjXaUGa4eerUdxl2hiwUQEAMiJpnlUanknPh3Rv2M-17PrzdaTRsruQw51iPUcMS4TvKNdYsS7z5Uzn0INA2r2qjM5FDrIU5U0kqUOMjXmkOoW-GHZmJVI1qoeYqjqyJGE_pdVXL7Fh5Y01RqGibpsmzQxQCsmur4kWpPgeMn_EQ0oy7FNPu19Ncq0-ox4Of_4JS8oxwBp162C_ua-iEjjwlOkfMyd84MTv0V5ivkjLRY9wzD8_qRzlztLPh9xtHepCGAgEttCbvYdip_KrWQJNrCGPpPD9WRrmArB1T2QlZkog7J8ioC2-iOKOMnbMTRGQkdVfhatolaEq_TzcJfCrp8pWshdh0YI_NNnY9Vq8no39mTJz15vAFHmEQK4_1B0uu7CctUBSdgR5EYJMFB4prCLxoftoAZFhcjM7GACt7hdXZYxYfdr3lwTA750C9OQhyy930xXYYxkMGeZ1cUi4FY_kQ9nrCSCKvOxXOV4c837w8YHzWyXHJcrKDZpJHGfMBdFtlzti7uArhniZ1BVU_zvPmNcqpiYc1a5tW904wvXc0AptNhenBTxsV-PJIqlkfLcNCgNMOBpB-THOFHqOhqK0lfa_eOdWJhqbz_0EHBnzh0XwrA8Yo2WklFXTngGmuPSI6Mhf7Xuni165rvoNq7m1XmsLupNGtaQdjHpVKO-EzPfc8jxwNvU0Q5k8g38eh21JyvpZAyKkME72jWvdyAVZQqufq3Vmo26Zg2ILS5KJeeJcIWCp4_dsr5yxBwe-jj44Vt7Hhh1agIv1-xQdnMdXBfgOt41kyeQQ1wzVq1hoEa9BZIrpRfcPf1FZZW5I9Buz0lQu9LnSyO8o6cVyMmUt1hqySutnXn-XMK3UDdBnE7OdvkcbXil5FpX5omvhZprIb1Oh76Epl6O9gO_1yJWdrYzznwm3M6lhnuKCUwjVzOnHMeyfEG3G2nxKpM2Uio1fI2NirFw0RY8DpcFuR145hIvmrhyLxZUFguSU4EyBMpHHPqJ2OU0jgBIfCyDpSbSZc3FYy4cpX8BGQjD01lxYU3yBcjDmxIiacqH2P13XpxZqQ4Vv6X6WxBYjNpqxtinsC2wq6ryF2Wuav1NcmGG_Hf5zWZPKr4vGdjPBEDmGaHEHx2pBviIxIG6Xoh90gKOR_83K1HSzK28n2KqcwA9_U3M3E_IAbiGgPQ9ZTZzpj1otbJXijVgyoyC1MoAYhQKbPqMcI0urUZTHRXYjTQR0MpFNMuKQvfZTjphVx10NHDRQGATWGiI6DeNqt4IW6NCQhPQVNXRZnu-XjbzjE6xIthqfzYl-L--tqjcblHeGC47LtDmOqpPdOyMlntdteybQAYkL1dVnXzKcFIxSvfJZgwrngZyUhYszHX9nsp6zhIsRXMbDEcQDFaRLvAQ6Z-oYgNSIHfxZGNBxIWwAdgY8wzW1sWZBqOqeYfROU1HsPKTSe9ZB7HVFAwtZFr0gS2L07T-XycXIIPBTMyJ-RWvKuG74uZ8wWifN4TWzthRUa6DwXkDiTtpqzHZt1hV8nUXOfDM0_MwDaNZLPRUekOjZz56lopUV3ZJq1h4zofqRx1FjZ4JBp8KcEGTtBsip_J07vLhxUw6gYPCWysvv2l2MpKKDBE8ysd42yLB4C5F71oZSqhYIRZlhah0VPqoMZ4RPr0t_xd5ChXUVhfnB_Zcmeb7InuPNiKOXbB8LVftQDqDd_SkIIStyBG2EL-q-xdePboPVOYeE5mJ7wRFqZryzjOL1KX9oQx4-7OzelNNvPPYaFaT6W4jLE0TOQdjZYC1GAzHk9W8XmRpkwQTV8iuCW-uJ_oVGzkD3xdHTX1IeCPrPgBpCSyi9rySPk4qi69rcbHu0MP2HPcAVlhowVxqeOesZQe2mnleBKrr4XMG2UIhAkzmI5EyIg3fedicuEFlF_ixPn8hT_XQcEzEeKfZnLSVH7WLyMQnxixZiAHOxYF7R3cZrpACchEPTj3t8syxWkShwRMA41Tu0fT87JmpmuYhSUPeizEvbmBSmXM2ikhWF_ySpSCwt9ya-kx48NGozoynPvhlT15HDfjW5qlDZdfRqgXP1pR3mxnIf3mM8vONStDjbFgAaiauTSLbadcEr7F8p7iv7JlIWjFCOF-P4hE7uEKBx1X9Oimhn3ANJOtwUTACRFmYJo-fzsGPZ2trnqVeSsAhPX90Ea-2007OVeqTBXNKJPHKVhx_RHHHuSPYgTq5usgaoDiZKhjPMFxyv8YrFT-ZEbIhd-oLFeHoOZNtPYn1s4cVh2T_XBJ8WNobTgNiFbCdNfhZE_dO0Th8u8j91Q6A8WHaMtPFMd2-wbod1mvEKJN1bwiHi2_qDXwEAqelyapO6BY01by_IGSZguJ6WPdE0JOBzW1hjgo_NWM6l6QHiAQpYr9AQsXQ23KOgElKbFfuk0HLUAhD2pUcAFEQIKDB2Tn4ok70Odrsk7AzinBEqSSj8RS0epixHq7xM5aryV46jgpMqcEIwI71_dSyf0TydmnCadljgRqHa09j35hIvBxw_sMTRiM7UMgtSsUj6lUNudojGyZc_7FPfV81mC8kKlEdPPiDvM0B9IxxgfxXHCwOwQJ1NYsFyRt2a6NO_so5J9Et2SQieHx_rpmOGbjd19x_mD97Oq36G9NTN7DN2NG9ihGoXQ7KNmLn1Kc5IWXHutyilYepISx-4AbG8QCHbaeI7oH7TQz4nImepSPWmCqal446D2k8MxfLQhowqi-XpDpm2dKj65bRusYxXX7f8zggRuGECupI2OdzFdRNpmBTQywTXa_M8ni0Phl7T1O0JVBouHg6t1HDuwKwF-m6tmDx38hiM7H6pZrxT1IlOYCzu6uFNP5_hb98c4hZ8FUn6906qt7kBcfHEjrkrvbYAp5SSo-IUDPFxigSVq4sI_7h7mgOo4PW_Ak3vwNp52P5-xf0aDPIkRfsXI0yRF2c59ovb4xrsNURVQiN_Ft8BTo5r9OayFTE6vT6Fre0o48IvlH-Dva8CsJSklrf5TrO3P-jL9qOOHYmTu0iWAZdQSvoPNbI-SNnpLg9udEgTDFc6eh91TbvouSbwbMy_bHcxcTH3pzCv6BD6EFD2pVW0az0zWgq49CTLXraU_5buV-xCY-sZvL1Cl5zdhDbaqTXnq49O1F9JvVILODL_-ZkT-_hsErv0pGqybbB2-EiDWgP8CBcbmaA6QNO3zPQogpV-P3n37c1qOFkCOT9J5lDPkYMEONH65T5bntweAcdwRc4karufYwN9ECEC2hflJuqU53cr4cXmm-D9NgzkzjkuXZxjBSZXeeKrZwUdXtfphiDUS--mShdgTB8Vkilb8nxYktn13sdgXwmpyYVUFecTwR04hD44gQiuUWfM1xNjKJaoidUnhJvSRZ0PQrbYMkTml2eUltzaVxz6IYCVgROKjA7h6XmeeKHQ3W9oW7w5SrpRyvf-gvFr9zi9nXN0gQJ3M2VyEPO4joCrKSU2O51k5aafI4l5q4IDHeSbaSJlpYmwSAKtVwIm_M_gcqHJAclsVT-LUOaV_jopjDw4uBmLt1LGzjTz1Uv5vhaV7ImRrtJvQ3eZI1buuEp5tc9yOTn4TReeVAIbUHI8h7Pjj-RNkEAr-g39mLlGHs-9fABSPLYvGFsapvE-XBPQdEsLeWyhDGHUovnNMgDDd0oGvoal1xCVgzEQyt93znfCCMzPhDi8wQlUj_ZI7awWobO5kWkKMWU1RF_E56EUa_zVn51U8e6OTYq-_RjsVzWrcZVLJVuOHVxoOpqGBujtMa0h_Y6; nfl_session.1=mdRXtNsJB3TsI4Yj9B6bWhRtODb7JPS-zm15zemQkOdL5FU5ghYaNKQk7ohTQkRsKKQiXW_GPCeAcd8rTKAZ2WhQ-I9whNHbtreLPCfzmkbetawfeEtBWWccHwlzunBC4iMuYPlFDqHgr6-UGNsAzXAyWSk1ok_ekNi9SALTZWQwn-qcfQd9EWcp7zEMfzIGv5QfCkXoTyjXsbi4ICOxpk5XtGiX-FsWroqwxx_6zMvvLAFDHWyiHv3e9OAG32-rY5-rPgHmclCkuAHspFjNlLEYMA3e1lIJDTiHYTpZ2a9Iz79Akipb_iFeJd9Z-56X5wEDy-MisdaPmJawhPNPXC7wKIyucuPhJr3-qDluksKs3H-oI5yyOUt_8piG65Q-OY7PFh_a3MAU5nPp3hAjkS8NFnpXVGPVZwbxtwodhF-w8ag7TjJjHgemmODuomNLfZRf_1QHVYrjGDbfHmGXpRrzYTokzg8ihp3ZCJV9TRkNllzMXJL132NBUKHEQQGxNZMQIya3CnCHJltIQai6AfvMhrH1vX2iQy-2pFTN1IM4k3_KRXgGSK6NcOiACB_wf421xhSaf1tqPv7uL8Idb3pJQb2Pb4f36aEMeX6a0jXIzJeifYJgmzHANKmt0wag-U-bgy6C8YExRKeu35_b1Lo_J4AFSoA5E5z52_K3WLayJYfiHOwRm5aDQ0bigz6DD53aoeS4OS0wD6vVPrNDaY1HEoJh42NbrX3GiCFbV6Fr3plmIhjXmFJ2tj9t7PLvQdn1FpZbGzeZBM-OpM2fJnEHaHO1pEWZssS9kGxfCf75jZs0wCt5oi86N5mCFw9g2uCWKmLatLuNJVVb0X3JjB_k7hfM7CLupP20cvSXgNiTC5nydj2Heg0vNZT6czNC6QmIs_aPuy69P3wN2hfnf_U-CGld6-hIHh_mJPSe38cOmDEDqVQTAIayWLkooNOT8zLC8SS9_hS2mBu6Bmkb7sw0omVmWwCtnOQdVbUbnWMR83rZz47iUH9LDsJz-mUA-_8zoiouK4OBprupfR5GvX8X3CfBtYoZonvg2CsMzEjxFqDnDvoLxEDkoki7BdRvR63SJ--2vLjwfRPWe2iKxsHTnDO98MZzA4Hy9__hnSDH5YzcBGCSPF_jfgFg8JjkfuDyJNqkBJgA7uyMwQ79kyFSamHXqjbbCt_2cUNd9xc2_64SVIiGJxXbYlq4unsGds93Ovzz09F0LGZMmnw3P4-aBhUT_5i_uSWmeueGuF3khSr6UKN-6gr0gUQtI8z5UYeQV6IUhizirrk5IGs7uT4iPtwiAsTlYTDpdNccoQFgWIETsK20AzjP_f7H1EFWlFKO-N9ycWDSIbBTpJmGEgx6WKukSZo1eE0ClrwJEH2rNJ44KIuNOyeD3WTVTK0RX-zBZV1xnt3QswsMlSOu9v7t5_IijKzjKtGUHSziYLoIanlEXhszkL4qhG12lEzOtEfhTpomMqpE5XFgmIb622lZ0NjchlPa4eppIQw8S2jsImdmf841fWEaGj955IBFjTjhybU_FLVx4qIeQPupeXPy0LfR9kGO5ad4cFP2LGWzy5VKA-qT06B5gihs4CLzR4ycwvMFjd9JYmpOfgYZZc0ZrkTBtfCz4rU9nMOp2G-YVUbZJKZ5jtBOcUe_w5aUoOnCNQ4pFVZqvl7fnTK8q-mL8DDFQGYMDrUOtihDL2DTvv26DnpskKA0vVpVupWELP-iHIgt8z5MsPbx9J_dldDg7Scnb-lkFa5A8-KTF7UKT0uC07N5ymmJoV70b-dDi8OyXT6YSyMVnRBgNVMtE6PED6QRc3jFIefTvwmBfWpDv28EO0z7REySkPZoVCHfBZwMYOfuXi7SKTFk1m_VNqRgagtcfPgm6by2UziiRokcH1d1xHMgSJg-3hK3ccAlBC9odrewDSwVMX92hiK_DmiGrfo_MDVaM1WAQcW80ZyaGn7YOwu2lSuWfZsEj-SNV8d-7SeK7hhbnAb7Mxd6nAT6f261euMGqia2j4dCAoEASME8KnrtyX3QfMYG4S9F2bSXBsWQ0GyOuQlefFBZYZs3zLfN72bpTg2aUZ3vqFa0sFdBskRLCD0vAcI4e3kZ2FXtqxYWLoqHDRZ7PE2dydPX8Xrbeo8KXtDK_cJnUQKW7-p-ziYm9yI1LEfHAPF4LdIRlVeU5LG5uuESqeouJLwOxFw4PfNQvSWslN8ZR4JSRfTldufAbwuxq8wP5QhFJRMkKDiIA4MXAh1dWgiVhYGI0ye0VY0DPZKo9aHtzkYdH95S9to5m1UhB7ht8ygAB-MOPbtUbY-_CIJuxGnj-tH7Ze35HWofSxBrpEeNysWCg7bWhZV_gqVAI6ScNbqKiM5NSH0xTD1e6GOg6WwSPAHlI4KQbyfWZCIuDaVr3uw3Y73ipDWx4HZcjYoqsAvTmwmMfeFkm08hDaaX2mnPt1BmaIFtS4zdf5WbWQMGIvRpWunu8nHU-4Q85nrPfslybIaM2Ka74yxibqcUaOTeu2ZjJfToflPksW8CjinAtNIgIydXRWlXinAbhsmId1zEEP_YdErJyy3J6Z5ZoCNChup8yqvdUwdrOb2Ss8vO-Lyr-KiJ0lRumxT5uPmxukcI_xxakDmQwb0xPIzt8Sopg0ElnGVtLtYT1L_5I1Zz45HVl4KrMJWnS5f7O7x2zBhG_yvPbygkVYukQCAAlRy6uyNLzMfOXe5aPeOge0GFsMYSSxgcutIIVGmYk3Pc3zhnECI_0qcsSfwV5YjFK5pFbyXGWQjPYmn730Tpflo4x5uVZo9Lsz6hv-Ng157AVzs_B2B2qUbk8uXfKZ7H_DpPu91qfnOFebxAGdi5JxMZxcxx8L67eTHh3HG3Nj8SYOvwZlJkm4dH85csCefhjrV_w_kHvjGpq39UYNTPRJmQFI_rA4jBDhHJtx6mlHavRgP-xBMwe3JWrLTba00mdscw6j90KsvuxCf_hvDb3tqMyosIuSAvbNDnTtcDt7il8r3XhYEg6xlb3Y45wwIy-1RYsXYnDjk1GwB3gIji3jWasFPOPJG-MxeKwmEUmJHB0H1falUOAv-mpI-BnxWTI6ee9Vgdvfo3k0sPHcflTnhvprZOGbnHq2DEdb_hEsci_Oc83CAwYpyed-M6M0D7s9IsrkGGZk9eqGRqPc4QnJjiMrn351Y4XTME0vkvRZkK73jy3I86-IkVtzY50maTen0XS0WYly5TrlapT7kFlmotKwEyl3zeer3Rz-R3JlBawx1sBvnue9eqACqEfxh7faGFcAiOTQ_sDVjFmmhn7FoE9qzB7_VEw7Bvtn4kr2sVeotcdbDY5S1tmZQg6loRft_2a0LAriC3dEMhcpvk0jsnLfLkb6s6f_XuPxG8Afwyyza2VmHrz6ZA9cJbRoWhaRR2E1tte5RxP4P5bOhFQolraO8jgo_eyQ2ajWi7ywFQv3HJTVEb8_YspmZAPMRFekEuG7-5EbPxYKY9gqUVmO0q2OnRhuJzVPlogm-9DL3wNIesCng7H_44N_PlSf4VVzTPEx1IL680a_r2aDuZqpHRFYviUYLAhmRGWs2eZ86TrGDU95A7n1lYrm_Wa3qVMi271smgRICRG3JDlQYjReLz0uuYJclCNRnvtB3GIoMbozNhjVvSUtYVBvitY_Z7ODwSqNE1zduopFD-Y8fIBDf3RdStvwPF8VtC9OixOb8fO8oycfYtU5kiHmClRzh1UCPXgyDQmanWiC5y4-ikQ5oxBCB1Q_keM87cr1ULfKePy2rjbT0Pqsy338BLLMbyhhjtbQaAoBYIUGTtdVszixzmsOVQQdAcXek51TnHJcXMflWceNc1fK7ODNHjUgjpdM666S0ZUXHZbxGRlWwZYiBRp0IiSKv0Vu0LHTmEumS5m1nsMApxQbFqZfvzzcohr3eeRyPIAp0tgEkdiaP7IMPz0sUmDf9EFpQViTWSkrx4G7InXnTBbBM4kdRt28P-XhV_wM72QkwutuzFGzD; nfl_session.2=1ohiCn6zmAP5O9Bg5GCHGrjz5uW0-CqEABo0VhNxTUQsQyhTyaJpzDvEMODgbiJXdZGkSR6hPdWusYWcL2dFzG-dN-qGoMUXdFaOCC5w56n_C_tWQf7lbBz9sZcLresmbG6hQeo8mnG-HWmWCIIaEv_5qeYjnzK-FQGxSq1-AR2dQjM8QLNwEm-BjvszpQpCD36nwUExINjqDP-flsuue0M-IxVqg40U7jBX6xMlNynjP8qOicwG1fwM6-pkvbq_MZ1tB6W-bELOfSapluJLU2EKrDYEuGRmEUp00n6y_d-9-8tYFqwlOh77M_Kx_j91X-zcUZVaViB6QSQTz9ehr8IZzIg63vwLrgwHsdVPgJAE.DRTj2Cx-ORZWwl8wLtewcA`;

const ID_TOKEN = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Ik9EQkVPRGxDUXpWR1JVUXhSRUl5UkRRNE1rVTJNekkzTlVaR1JUWkNPRFJCUkRZNU9URXhOUSJ9.eyJodHRwczovL2FjY291bnRzLm1lZXRkYXBwZXIuY29tL3ByZWZlcnJlZF91c2VybmFtZSI6IkphbWVzZGlsbG9uYm9uZCIsImh0dHBzOi8vYWNjb3VudHMubWVldGRhcHBlci5jb20vaWRlbnRpdHlfdmVyaWZpZWQiOnRydWUsImh0dHBzOi8vYWNjb3VudHMubWVldGRhcHBlci5jb20vZmxvd19hY2NvdW50X2lkIjoiYmQ5NGNhZGUwOTdlNTBhYyIsImh0dHBzOi8vYWNjb3VudHMubWVldGRhcHBlci5jb20vaXNOZXdBY2NvdW50IjpmYWxzZSwiaHR0cHM6Ly9hY2NvdW50cy5tZWV0ZGFwcGVyLmNvbS9pcCI6IjM0LjE4Mi4zMS4yMTEiLCJodHRwczovL2FjY291bnRzLm1lZXRkYXBwZXIuY29tL2lzUmVhZE9ubHkiOmZhbHNlLCJnaXZlbl9uYW1lIjoiVHJldm9yIiwiZmFtaWx5X25hbWUiOiJEaWxsb24tQm9uZCIsIm5pY2tuYW1lIjoidGRpbGxvbmJvbmQiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJKYW1lc2RpbGxvbmJvbmQiLCJuYW1lIjoiVHJldm9yIERpbGxvbi1Cb25kIiwicGljdHVyZSI6Imh0dHBzOi8vc3RvcmFnZS5nb29nbGVhcGlzLmNvbS9tZWV0ZGFwcGVyLWFzc2V0cy9pbWcvYXZhdGFycy9lNjk0YjhjMi0wZTg3LTRhNzYtYWQ5ZS0xODhlNzQ3MzVmYWMiLCJsb2NhbGUiOiJlbiIsInVwZGF0ZWRfYXQiOiIyMDI2LTA0LTA4VDAyOjI1OjEyLjMxOFoiLCJlbWFpbCI6InRkaWxsb25ib25kQGdtYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJpc3MiOiJodHRwczovL2F1dGgubWVldGRhcHBlci5jb20vIiwiYXVkIjoiMDdzYUVZUU16V0Nlck00WnRmNVpYQkkydUo0dGFTblYiLCJzdWIiOiJnb29nbGUtb2F1dGgyfDEwODk0MjI2NzExNjAyNjY3OTEwNSIsImlhdCI6MTc3NjAzNDExNCwiZXhwIjoxNzc2MDcwMTE0LCJzaWQiOiJ1ZUhVRkJRQjR1dkUtd1JrY3ljSEVnOUJDQTJNX2k2RCJ9.B26RzsyjIlok4vdSL2uqugdtblp_mmfuAHb4_I1O3R3GX0IdhuU-3gx8irET98KXfvNlQgLa-J3NOOX1RWtt4Q30vleLyZkmS-SlZDfLM_LzcpA1i46dVCSomSHpno2NRHkZF5XthOWC69HXXY8atLYXzJ8DBNH9nAR1nDx5p4FfEFaGHoptgccYdUxQEYXnMKMlr0CPKjfOEqDkF1fUGC3g_V8WdGBpSU7Ky8uAVPcm7zLlqOn0ZLXeyZJpQv81EI5gkD-QXvriRpMhPiAL-wNT2D5xJA8bOb75gTj-GBqz3akZ7hlZme5FvSDGLDU7ZNgtKIN4khCZFldEGku1KQ`;

// Simplified query - only fetch the fields we need
const GQL_QUERY = `query searchMomentNFTsV2_collection($after: String, $first: Int, $byOwnerFlowAddresses: [String]) {
  searchMomentNFTsV2(input: {after: $after, first: $first, filters: {byOwnerFlowAddresses: $byOwnerFlowAddresses}, sortBy: ACQUIRED_AT_DESC}) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        flowID
        editionFlowID
        serialNumber
        lockExpiresAt
        edition {
          tier
          seriesFlowID
          maxMintSize
          set { flowID name }
          play { metadata { playerFullName teamName playType } }
          series { flowID name }
        }
      }
    }
  }
}`;

async function fetchPage(cursor) {
  const res = await fetch('https://nflallday.com/consumer/graphql?searchMomentNFTsV2_collection', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'origin': 'https://nflallday.com',
      'referer': 'https://nflallday.com/user/Jamesdillonbond',
      'cookie': COOKIES,
      'x-id-token': ID_TOKEN,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      operationName: 'searchMomentNFTsV2_collection',
      variables: {
        after: cursor,
        first: 100, // max per page
        byOwnerFlowAddresses: ['bd94cade097e50ac'],
      },
      query: GQL_QUERY,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  ALL DAY COLLECTION FETCHER');
  console.log('═══════════════════════════════════════════\n');

  let cursor = null;
  let page = 0;
  let allMoments = [];

  // Step 1: Fetch all pages from nflallday.com
  while (true) {
    page++;
    const data = await fetchPage(cursor);
    const search = data?.data?.searchMomentNFTsV2;
    if (!search) { console.error('Bad response:', JSON.stringify(data).slice(0, 500)); break; }

    const edges = search.edges || [];
    for (const edge of edges) {
      const n = edge.node;
      allMoments.push({
        nftId: n.flowID,
        editionId: String(n.editionFlowID),
        serialNumber: n.serialNumber,
        tier: n.edition?.tier,
        setName: n.edition?.set?.name,
        playerName: n.edition?.play?.metadata?.playerFullName,
        teamName: n.edition?.play?.metadata?.teamName,
        seriesFlowId: n.edition?.seriesFlowID || n.edition?.series?.flowID,
        locked: !!n.lockExpiresAt,
      });
    }

    console.log(`  Page ${page}: ${edges.length} moments (total: ${allMoments.length}/${search.totalCount})`);

    if (!search.pageInfo.hasNextPage) break;
    cursor = search.pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 500)); // rate limit
  }

  console.log(`\n  Fetched ${allMoments.length} moments total\n`);

  // Step 2: Update wallet_moments_cache in Supabase
  let updated = 0;
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < allMoments.length; i += 50) {
    const batch = allMoments.slice(i, i + 50);
    
    for (const m of batch) {
      // Try to update existing locked record first
      const { data: existing } = await supabase
        .from('wallet_moments_cache')
        .select('moment_id')
        .eq('moment_id', m.nftId)
        .eq('collection_id', AD_COLLECTION_ID)
        .limit(1);

      if (existing && existing.length > 0) {
        // Update existing record with real edition data
        const { error } = await supabase
          .from('wallet_moments_cache')
          .update({
            edition_key: m.editionId,
            serial_number: m.serialNumber,
            player_name: m.playerName,
            set_name: m.setName,
            tier: m.tier,
            team_name: m.teamName,
          })
          .eq('moment_id', m.nftId)
          .eq('collection_id', AD_COLLECTION_ID);
        if (error) { errors++; } else { updated++; }
      } else {
        // Insert new record (moment not found by scanner - unlocked and not previously discovered)
        const { error } = await supabase
          .from('wallet_moments_cache')
          .upsert({
            moment_id: m.nftId,
            collection_id: AD_COLLECTION_ID,
            wallet_address: '0xbd94cade097e50ac',
            edition_key: m.editionId,
            serial_number: m.serialNumber,
            player_name: m.playerName,
            set_name: m.setName,
            tier: m.tier,
            team_name: m.teamName,
          }, { onConflict: 'wallet_address,moment_id' });
        if (error) { errors++; } else { inserted++; }
      }
    }

    if ((i + 50) % 500 === 0 || i + 50 >= allMoments.length) {
      console.log(`  Progress: ${Math.min(i + 50, allMoments.length)}/${allMoments.length} — updated: ${updated}, inserted: ${inserted}, errors: ${errors}`);
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`  DONE! Updated: ${updated}, Inserted: ${inserted}, Errors: ${errors}`);
  console.log('═══════════════════════════════════════════');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
