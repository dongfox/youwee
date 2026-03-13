# Nhật ký thay đổi

Tất cả thay đổi đáng chú ý của Youwee sẽ được ghi lại trong file này.

Định dạng dựa trên [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
và dự án tuân theo [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Đã sửa
- **Ban giao truyen tai sang Rust cho crawler** - Crawler direct-media downloads nay uu tien goi binary Rust `crawler_downloader` de tai file thuc te, trong khi Python tiep tuc xu ly quet/loc/bao cao va chi fallback ve downloader noi bo khi duong Rust khong kha dung hoac loi
- **Dieu tiet ket noi theo host cho crawler** - Probe requests, segmented downloads, va single-stream fallback cua media gio dung chung gioi han song song theo host, kem chan doan luc khoi dong va log cho khi host bi nghen
- **Lap lich worker cho tai phan doan cua crawler** - Range downloads now determine the real worker count after pending chunks are expanded, log the actual dispatch concurrency, and emit periodic wait heartbeats so large in-flight chunks no longer look like a frozen download
- **Tai phan doan thich ung manh hon cho crawler** - Crawler direct-media transfers now scale up to 12 parallel ranges by file size and host profile, resume unfinished `.part` segments instead of restarting them from zero, keep chunk state across failed runs for true resume, and size the HTTP connection pool for heavy multi-range runs
- **Retry rieng cho tung doan khi tai bang Range** - Parallel `Range` downloads now retry each part independently instead of restarting the whole file on a single segment failure, including Google Photos image and video hosts
- **Chinh sach read-timeout theo domain cho crawler** - The crawler now applies longer read timeouts for slower image hosts such as `i.ibb.co` and Google user-content URLs while keeping default connect timeouts short, and startup logs now print the active timeout policy map
- **Do on dinh khi tai media tu image host** - Image downloads now use each item's source page as the `Referer`, print effective download timeout settings at startup, and relax the `stable_large` template's throttling defaults so large album runs no longer self-limit as aggressively
- **Tinh chinh timeout va retry khi tai crawler** - Direct image downloads now use separate connect/read timeouts, larger stream chunks, and skip repeated retries for non-retryable HTTP failures so slow media hosts fail less often and exhausted retries no longer drag throughput down
- **Crawler bi dung truoc giai doan tai xuong sau khi quet xong** - Da sua loi so luong gia tri tra ve cua `crawl_pages()` khong khop (`expected 5, got 4`), khien qua trinh phat hien hoan tat nhung bi dung truoc khi buoc tai xuong thuc su bat dau
- **Resolve duong dan output va thong tin bao cao cho crawler** - Popup hoan tat va thao tac mo thu muc gio uu tien dung duong dan that tu preview/report va metadata save path, trong khi bao cao ghi du du thong tin de tim lai dung thu muc media thay vi roi ve retry folder hay output cap tren
- **Log crawler sidecar UTF-8** - Sidecar gio ep `PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1` va output khong buffer truoc khi spawn `image_crawler.py`, tranh viec log tieng Trung va duong dan thu muc bi vo ma trong ung dung

### Thêm mới
- **Bo sung duong phat an cho playlist JPG-sequence** - Trinh phat HLS trong ung dung gio phat hien manifest thuc chat la danh sach frame anh, nhu JPG sequence cua AVJB `newembed`, va render no bang duong frame-sequence noi bo thay vi dua cho giai ma video Hls.js thong thuong
- **Ngu canh phat AVJB va thu tu fallback** - Luong phat resolve tu trang gio se mang theo Referer/Origin cua trang nguon, bo qua native-HLS shortcut khi can ngu canh trang, va chi fallback sang JPG-sequence sau khi Hls.js that bai that su de hanh vi AVJB 
ewembed gan hon voi userscript goc
- **Lam moi luong ky so ngan han luc bat dau phat** - Cac muc duoc resolve tu trang gio se giu lai source page va resolve lai URL stream khi viewer mo, tranh truong hop manifest ky so ngan han nhu m3u8 `newembed` cua AVJB het han truoc khi playback bat dau
- **Mo rong fallback newembed cua AVJB sang avjb.com** - Trinh resolve luong trang web an nay gio ap dung fallback video/embed cua AVJB cho ca `avjb.cc` va `avjb.com`, giong chien luoc cua userscript goc la lay `/newembed/<videoId>` de rut ra nguon m3u8 co the phat
- **Tich hop an trinh resolve luong trang web chung vao luong M3U hien co** - Bo nap URL M3U hien tai gio se phan biet media truc tiep, van ban playlist va trang web thong thuong, goi lenh Tauri backend tong quat de trich xuat nguon m3u8/mp4/video co the phat va dua ket qua vao pipeline HLS play/download hien co ma khong them UI rieng
- **Rust phuc hoi song song va khoi trang thai dieu do rieng** - Scheduler Rust nay se tang lai `dispatch_limit` sau mot so segment on dinh lien tiep, va khu vuc trang thai task gio hien metric cua Rust trong mot khoi rieng
- **Rust giam kich thuoc chunk theo cua so cham va ha song song theo loi host** - Scheduler Rust nay se thu nho chunk sau cac segment cham lien tiep, phan loai retry theo request/status/stream/incomplete, va tu dong giam dispatch limit khi host ImgBB hoac Google loi lap lai qua nhieu
- **Tai can bang lai chunk truoc khi dispatch va bo dem dieu do Rust** - Downloader Rust nay se tiep tuc tach cac pending range qua lon truoc khi giao cho worker theo kich thuoc chunk thich ung hien tai, va panel trang thai task se hien wait/retry/tune/rebalance counts
- **Han muc truyen tai theo host va thong ke dieu do Rust thoi gian thuc** - Rust crawler downloader nay ap dung gioi han segment/chunk rieng cho ImgBB va Google media, ghi log host policy hien tai, va hien active/pending/EWMA scheduler stats ngay trong panel trang thai task
- **Rust tiep quan vong lap dieu do phan doan** - Downloader Rust cua crawler nay tiep quan toan bo dieu do segmented transfer, gom manifest, hang doi pending/in-flight/completed, resume tung part va hop nhat cuoi cung, thay vi de Python giu vong lap phan chunk
- **Rust work-stealing cho range va thu nho chunk voi ket noi cham** - Tai segmented bang Rust gio duy tri hang doi remaining-range dung chung, tiep tuc tach cac khoi lon khi worker ranh, va tu dong tang/giam kich thuoc chunk theo thong luong thuc te de ket noi nhanh lay them viec con ket noi cham som giai phong
- **Tien trinh truyen tai Rust theo thoi gian thuc** - Rust `crawler_downloader` nay phat log tien trinh truyen tai lien tuc, Python stream truc tiep cac log do vao crawler task, va panel trang thai hien che do Rust transfer, so lan fallback va thong luong hien tai
- **Preset truyen tai tu dong cho crawler** - Khi de trong cac truong host/range/chunk, URL ImgBB va Google Photos se tu dong ap dung gia tri mac dinh phu hop hon de giam viec canh tay tham so
- **Tham so tinh chinh host/range cho crawler** - Crawler Task nay co the dieu chinh host parallel limit, gioi han worker cho tung file range, va kich thuoc chunk ngay trong UI ma khong can viet extra args thu cong
- **Khung downloader Rust cho crawler** - Da them binary Rust doc lap `crawler_downloader`, co the doc manifest `.parts.json` cua crawler va bao cao trang thai resume cua tung part, tao diem vao CLI dau tien cho backend truyen tai native sau nay
- **Truu tuong hoa lop truyen tai cua crawler** - Segmented va single-stream transfers cua crawler gio di qua mot transport wrapper rieng, giup logic lap lich chunk co the tien hoa doc lap va mo duong cho backend truyen tai Rust/native trong tuong lai
- **Manifest va bo lap lich chunk cho tai phan doan cua crawler** - Ranged crawler downloads now persist a `.parts.json` manifest beside the target file, keep `.part` chunks after real failures for later resume, dynamically split oversized pending chunks as workers free up, adapt later chunk sizes from observed throughput, and log worker/chunk counts so resumable multi-range transfers behave more like a real download manager
- **Cong tac chuyen doi che do tai va thong ke tai phan doan cho crawler** - The crawler task UI now exposes segmented versus single-stream download mode, and task status summarizes segmented hits, fallbacks, and per-part retries from sidecar logs
- **Mac dinh uu tien tai direct-media bang nhieu doan** - Any crawler direct-media file that exposes `Accept-Ranges: bytes` now attempts IDM-style 2-4 parallel `Range` requests first, with automatic single-stream fallback when the server does not honor segmented transfers
- **Vung thu gon cho trang thai, nhat ky va trinh duyet media cua crawler** - The crawler task card now keeps task status open by default while tucking live logs and the media browser into dedicated collapsible sections for a cleaner working layout
- **Bang tham so task crawler co the thu gon** - The crawler task card now keeps URL/output fields visible while moving advanced options, import filters, and related task parameters into a collapsible panel so the default layout stays cleaner
- **Tong ket bao tri crawler va M3U trong ngay** - Da dua toan bo thay doi crawler sidecar, fallback Telegraph, mac dinh media browser, va sua request chain cua M3U/HLS vao muc `Unreleased` de de tiep tuc bao tri
- **Tac vu crawl Telegram fallback** - Canh bao Telegraph mat nguon anh va popup hoan tat nay hien lien ket Telegram fallback, cho phep mo Telegram, dua lien ket vao form nhiem vu crawl, hoac bat dau crawl ngay lap tuc; sidecar dong thoi truyen qua `cookies_file` va tham so kiem tra dang nhap
- **Mac dinh, bo loc va dieu khien chi tiet cho media browser crawler** - Media browser cua crawler gio mac dinh gon hon, nho tuy chon thu gon/mo rong, co bo loc theo tieu de/trang/ten tep/duong dan da luu/trang thai da tai, va cho phep mo-thu gon theo tung the hoac hang loat
- **Crawler task completion toast** - Tac vu crawler thanh cong gio hien thong bao hoan tat trong ung dung kem thao tac mo nhanh thu muc dau ra da resolve
- **Kha nang hien thi output va tai direct-media trong Universal** - Luong import/thu lai gio hien ro va tai su dung thu muc dich, Universal mo duoc thu muc output, hien duong dan file da luu, va cho phep cau hinh tai phan doan cho media duoc crawler dua vao
- **Custom M3U request headers** - Trang M3U giờ hỗ trợ nhập HTTP headers theo từng nguồn và dùng chúng cho cả bước tải playlist từ xa lẫn phát HLS trong ứng dụng
- **In-app download completion toast** - Hàng đợi Download và Universal giờ hiển thị thông báo hoàn tất tải ngay trong ứng dụng kèm lối tắt mở vị trí file đã lưu
- **Native HLS proxy loader** - Trinh phat HLS trong ung dung gio proxy manifest chinh, playlist con, segment media va key giai ma qua Tauri backend thay vi chi sua manifest cap cao nhat
- **Mo rong pham vi phan tich M3U** - Phan tich M3U/M3U8 gio resolve URL tuong doi dua tren playlist nguon, ho tro `#EXT-X-STREAM-INF` cho master playlist, tu dong loai bo muc trung lap, va giu lai them metadata IPTV nhu `tvg-name`, `tvg-id`, `group-title`
- **Ho tro luong M3U/M3U8** - Crawler gio phat hien va thu thap lien ket playlist HLS `.m3u` va `.m3u8`. Media browser va viewer phat truc tiep luong HLS thong qua hls.js. Cac luong da phat hien co the import vao Universal de tai qua yt-dlp
- **Khong gian lam viec M3U va cong cu quan ly thu vien** - Trang M3U moi gio tap hop nap playlist, duyet/phat truc tiep, yeu thich, lich su tai, batch download theo thu muc, va quan ly yeu thich theo folder trong mot quy trinh thong nhat
- **Thong bao loi phat M3U va trinh phat ngoai** - Khi luong HLS hoac truc tiep khong phat duoc (vi du codec H.265/HEVC khong ho tro), hien overlay loi va nut "Mo bang trinh phat ngoai" va "Sao chep URL". Loi CORS manifest tu dong thu lai qua Tauri backend proxy
- **Phat hien va huong dan cai HEVC codec** - Tu dong kiem tra he thong co cai codec H.265/HEVC khong. Khi chua cai va phat loi, hien the cai dat voi lien ket truc tiep den Microsoft Store HEVC Video Extensions (mien phi)
- **Do on dinh cua phat va tai xuong M3U/HLS** - Chuoi M3U/HLS gio gui day du playback headers, ton trong thu muc tai da chon, rewrite proxy manifest dung hon, va dua ra chan doan ro rang hon cho cac luong chi co tieng hoac can them header
- **Quy trinh xem truoc thu muc lich su va khoi phuc task crawler** - Thu muc lich su gio co the tu dong quet `data`, hien chan doan ro hon, tiep tuc nap preview sau khi sidecar khoi dong lai, va kich hoat luong thu lai file loi truc tiep tu output da luu
- **Bộ chọn nguồn dependency (yt-dlp/FFmpeg)** - Thêm tùy chọn trong Cài đặt -> Phụ thuộc để chọn dùng binary do ứng dụng quản lý hoặc do hệ thống quản lý
- **Xác nhận an toàn khi chuyển sang nguồn hệ thống** - Thêm hộp thoại xác nhận khi đổi yt-dlp/FFmpeg sang nguồn hệ thống để tránh bấm nhầm
- **Bộ chọn kiểu API proxy cho nhà cung cấp tùy chỉnh** - Thêm các chế độ Third-party OpenAI, OpenAI Responses và NewAPI Gateway trong AI Settings, kèm ghi chú khác biệt về suffix/response
- **Lấy danh sách model từ nhà cung cấp OpenAI/Proxy** - Thêm nút Fetch Models để tải trực tiếp model khả dụng từ endpoint nhà cung cấp
- **Thêm mục Image Crawler ở sidebar** - Bổ sung nút riêng ở thanh trái để mở nhanh giao diện crawler
- **Mở rộng tùy chọn tác vụ crawler** - Thêm file queue/retry, preset template, regex include/exclude URL và bộ lọc kích thước/độ phân giải để tái sử dụng thêm khả năng của image_crawler
- **Bảng duyệt media trong Crawler Task** - Thêm trình duyệt media ngay trong giao diện crawler với nút tải preview, lọc theo All/Image/GIF/Video/Audio, ô xem nhanh và nút mở link gốc
- **Hop thoai xem media trong ung dung** - Them lop xem media trong ung dung cho ket qua crawler, cho phep mo truc tiep tu o preview va di chuyen truoc/sau trong bo loc hien tai
- **Dieu khien ban phim va che do anh cho viewer** - Bo sung phim tat Trai/Phai/Esc va chuyen doi giua vua cua so va kich thuoc goc trong crawler viewer
- **Quy trinh thu lai/xuat/phan thu muc cho crawler** - Them thu lai cac muc tai xuong loi cua crawler, xuat browser va link, hien link trang goc trong media browser, va tu dong tach thu muc theo tung trang khi dua vao Universal
- **Payload chẩn đoán health của sidecar** - Endpoint `/health` giờ trả thêm build id, PID và đường dẫn script để xác minh đúng instance sidecar đang chạy
- **Tự động điền khi chọn template crawler** - Chọn template preset (Speed Mode, High Quality, Fast Preview, Strict Site, Stable Large) sẽ tự động cập nhật các trường liên quan (workers, timeout, delay, retries, scope, v.v.) phù hợp với logic `apply_template_defaults()` của Python
- **Chẩn đoán tốc độ tải crawler** - Log tiến trình in tốc độ tải và thời gian mỗi 10 file (`[PROGRESS] 50/200 (2.5/s, 20s)`) và cấu hình session khi khởi động (`[NET] pool_maxsize=12 workers=8 ...`)

### Sửa lỗi
- **Crawler duplicate-name visibility** - Khi file crawler trùng tên với file đã có, crawler giờ ghi log `[EXISTS] ...` và đánh dấu trong bản ghi thành công để log nhiệm vụ và báo cáo đều hiển thị được lần lưu trùng tên
- **Sua hieu nang va tinh song song cua crawler** - Crawler gio mo rong connection pool, tranh sleep trong khoa RPS, dung chunk stream lon hon, va tang muc song song mac dinh de batch image khong con bi tuong duong chay tuan tu
- **Task crawler lỗi "Unknown media type(s): m3u, m3u8"** - Loại bỏ `m3u,m3u8` không hợp lệ khỏi danh sách media types mặc định. Thêm kiểm tra runtime để tự động lọc bỏ type không hợp lệ từ localStorage
- **Lỗi EACCES Vite dev server trên Windows** - Port 5173 bị Windows Hyper-V/WinNAT giữ. Đổi dev server sang `127.0.0.1:9981` với `strictPort: false` tự động fallback

- **Da on dinh viec polling duong dan data artifact cua crawler** - Moi vong polling task gio chi tinh va ghi mot lan duong dan `data` cuoi cung, khong con nhay qua lai giua duong dan output fallback va duong dan suy ra tu preview, nen nhan duong dan artifact khong con nhap nhay
- **Artifact bao cao cua crawler gio duoc chuyen vao thu muc `data` cua thu muc media** - Sau khi task ket thuc va media nam trong mot thu muc duoc tao moi duy nhat, bao cao, link preview, danh sach loi, checkpoint va hash se duoc chuyen tu `output/data` vao thu muc `data` cua thu muc media do, va sidecar cung tim theo vi tri moi
- **Metadata cua crawler gio duoc ghi vao `output/data`** - Link preview, bao cao, danh sach loi, checkpoint, huong dan recovery va hash log nay deu duoc ghi vao thu muc con `data`, va sidecar cung kiem tra ca root lan `data`
- **Crawler gio da xuat link xem truoc trong luc quet** - Tac vu quet thong thuong nay se cap nhat `image_links.txt/csv` ngay trong giai doan phat hien de Load Preview doc duoc media cua task hien tai truoc khi tai xong
- **Direct download tu crawler gio resolve dung thu muc dich truoc** - Media nhap tu ket qua crawler gio xac dinh duong dan tuyet doi hop le truoc khi tao thu muc con theo trang, giup file vao dung cay thu muc da chon
- **Nhãn nguồn hệ thống theo hệ điều hành** - Nhãn nguồn hệ thống giờ hiển thị theo nền tảng (Homebrew trên macOS, PATH trên Windows, trình quản lý gói trên Linux)
- **Proxy routing theo mode** - Sinh endpoint theo kiểu API đã chọn: OpenAI/NewAPI dùng chat-completions, OpenAI Responses dùng responses endpoint kèm fallback tương thích
- **Chuẩn hóa proxy vẫn giữ proxy_api_style** - Luồng normalize/test cấu hình AI giờ lưu proxy_api_style cùng endpoint/model
- **Mô tả crawler chuyển sang phạm vi media tổng quát** - Cài đặt nêu rõ sidecar hỗ trợ Google Photos và trang media thông thường
- **Vong doi task, phuc hoi va hanh vi tat cua sidecar** - Sidecar gio tranh duoc deadlock, phuc hoi on dinh hon khi gap `task_running` stale hay transport disconnect, tam dung polling loi, va dung cung cua so chinh thay vi de lai listener an

### Sửa lỗi
- **Retry failed downloads dung du lieu cu va sai format** - Sua 4 bugs: (1) folder mode dung cache; (2) retry file candidates khong verify tren disk; (3) folder mode voi `currentTaskId` cu skip direct-import; (4) `failed_downloads.txt` dung JSON format nhung code doc nhu plain URL. Fix: parse JSON de lay url, page_url, album_name, output_subdir
- **Nut Retry Failed Downloads khong hoat dong o che do thu muc lich su** - Nut Retry Failed Downloads bi vo hieu hoa va khong hoat dong khi dung che do thu muc vi yeu cau task ID tu sidecar. Gio ho tro che do thu muc bang cach doc truc tiep `failed_downloads.txt` tu thu muc lich su va nhap lai cac URL loi vao hang doi Universal
- **Bat dau crawler gio uu tien URL va queue hon retry file cu** - Bat dau task thong thuong se khong bi `retry_failed_from` da nap truoc do chiem quyen nua; che do retry chi duoc dung khi URL va queue deu trong
- **Thu lai file loi cua crawler nay co gang giu nguyen thu muc con** - Ban ghi loi gio luu context trang va thu muc con, va che do retry cung backfill ban ghi cu tu `download_report.csv` hoac thu muc media duy nhat de file thu lai quay ve thu muc album goc khi co the
- **Trang thai xem truoc rong cua crawler da phan biet luc dang chay** - Media Browser hien thong bao dang cho tao link xem truoc khi task con chay thay vi bao khong co link qua som
- **Tai preview gio hien trang thai dang tai truoc khi phan tich file lon** - Nut Load Preview nay se render trang thai dang tai truoc khi xu ly bao cao lon, giam cam giac bam ma khong co phan hoi
- **Direct-media gio gui kem Referer cua trang nguon** - Media truc tiep nhap tu crawler gio gui URL trang nguon trong header `Referer`, tang tuong thich voi host chan hotlink
- **Thong bao lich khong con xin quyen giua luc tai** - Thong bao bat dau/dung/hoan tat theo lich chi gui khi he thong da cap quyen truoc do, tranh popup bat ngo sau khi tai xong
- **Thieu dau phan cach trong duong dan tai xuong mac dinh** - Sua loi ghep duong dan fallback tren Windows de output mac dinh tro dung vao thu muc Downloads that
- **Khong tao thu muc con cho ket qua crawler** - Sua loi direct-media dung output path rong/tuong doi lam khong tao thu muc hoac lam file nam sai thu muc tai xuong
- **Hang doi Universal khong phan biet duoc direct-media** - Them nhan direct-media va so doan tren queue item de phan biet voi tai bang yt-dlp
- **Nối suffix sai với base URL kiểu responses** - Sửa lỗi ghép endpoint dạng /v1/responses/chat/completions gây 404
- **Chẩn đoán endpoint proxy tốt hơn** - Thông báo lỗi nay hiển thị endpoint đã thử để dễ đối chiếu với client ngoài (ví dụ Cherry Studio)
- **Truyền cờ nâng cao crawler qua sidecar** - Bổ sung truyền auto-scope, prefer-type, template, regex/size filters và extra_args sang image_crawler.py
- **Thiếu lưu task_image_types** - Sửa lỗi không ghi nhớ task_image_types giữa các lần mở app
- **Deadlock khóa task trong sidecar** - Sửa lỗi lock re-entry trong vòng đời task Python sidecar (`append_log` khi đang giữ task lock) gây treo `/api/v1/tasks` và giữ `running_task_id` sai
- **Vòng lặp `task_running` giả** - Sửa nhận diện task đang chạy bị stale để task đã kết thúc/crash không chặn lần start mới
- **Fallback start task khi sidecar ngắt kết nối tạm thời** - Sửa trường hợp kiểm tra `running_task_id` bị `error sending request` khiến luồng start bị dừng giữa chừng

## [0.11.1] - 2026-03-01

- **Hỗ trợ tiếng Pháp, Bồ Đào Nha và Nga** - Bản địa hóa đầy đủ Français, Português và Русский cho toàn bộ giao diện, cài đặt, thông báo lỗi và nhãn metadata
- **Bản địa hóa thông báo lỗi backend** - Các thông báo lỗi từ backend (lỗi tải, lỗi mạng, v.v.) giờ được dịch theo ngôn ngữ người dùng đã chọn thay vì luôn hiển thị tiếng Anh

- **Tái cấu trúc chuỗi fallback transcript** - Thống nhất logic fallback transcript giữa AI summary và processing để hành vi nhất quán hơn

### Sửa lỗi

- **Fallback transcript cho Douyin và TikTok** - Cải thiện trích xuất transcript cho video Douyin và TikTok trước đây bị thất bại im lặng
- **Lỗi transcript và caption ngắn** - Lỗi transcript giờ được giữ lại để chẩn đoán thay vì bị nuốt im lặng; caption ngắn được chấp nhận là transcript hợp lệ thay vì bị từ chối
- **Cài đặt mặc định TikTok** - Điều chỉnh cài đặt tải mặc định của TikTok cho phù hợp với quy ước nền tảng

## [0.11.0] - 2026-02-20

- **Browser Extension tải nhanh (Chromium + Firefox)** - Giờ đây bạn có thể gửi trang video đang mở từ trình duyệt sang Youwee và chọn `Download now` hoặc `Add to queue`
- **Thiết lập Extension trong Cài đặt** - Thêm mục mới Cài đặt → Extension với nút tải trực tiếp và hướng dẫn cài đơn giản cho Chromium và Firefox

- **Làm mới UI/UX cho trang YouTube và Universal** - Tối giản thao tác nhập link, card preview, hàng đợi và phần title bar để giao diện gọn và đồng nhất hơn

### Sửa lỗi

- **Đồng bộ resolve dependency giữa các tính năng** - Chuẩn hóa luồng chọn yt-dlp/FFmpeg trong download, metadata, channels và polling nền để luôn tôn trọng nguồn đã chọn
- **Chế độ system fail rõ ràng khi thiếu binary** - Khi chọn nguồn hệ thống mà thiếu binary, ứng dụng giờ báo lỗi rõ ràng thay vì fallback ngầm

## [0.10.1] - 2026-02-15

- **Thiết lập font ASS** - Thêm tùy chỉnh font và cỡ chữ phụ đề cho xuất ASS và preview
- **Luồng xuống dòng phụ đề** - Thêm thao tác auto xuống dòng nhanh và hỗ trợ Shift+Enter khi chỉnh nội dung
- **Tự động thử lại có thể cấu hình** - Thêm cài đặt Auto Retry cho tải YouTube và Universal, cho phép đặt số lần thử lại và thời gian chờ để tự phục hồi khi mạng không ổn định hoặc live stream bị ngắt


### Sửa lỗi

- **Thông báo lỗi tải xuống rõ hơn** - Cải thiện thông báo lỗi yt-dlp với nguyên nhân cụ thể hơn để hỗ trợ nhận diện lỗi tạm thời và thử lại tự động chính xác hơn

## [0.10.0] - 2026-02-15

- **Xưởng phụ đề** - Thêm trang phụ đề tất cả trong một cho SRT/VTT/ASS với chỉnh sửa nội dung, công cụ thời gian, tìm/thay thế, tự sửa lỗi và các tác vụ AI (Whisper, Dịch, Sửa ngữ pháp)
- **Bộ công cụ phụ đề nâng cao** - Bổ sung timeline sóng âm/phổ tần, đồng bộ theo cảnh cắt, QC realtime theo style profile, công cụ tách/gộp, chế độ Dịch 2 cột (gốc/bản dịch), và công cụ batch cho project


### Sửa lỗi


## [0.9.4] - 2026-02-14

- **Chọn thư mục output cho Processing** - Thêm nút chọn thư mục lưu đầu ra trong khung chat Processing. Mặc định vẫn là thư mục của video chính, và output của AI/quick actions sẽ theo thư mục đã chọn
- **Đính kèm nhiều loại file trong chat AI Processing** - Chat Processing hỗ trợ đính kèm ảnh/video/phụ đề (chọn file + kéo thả), hiển thị preview và metadata phù hợp theo từng loại
- **Lối tắt đề xuất ngôn ngữ trong Cài đặt** - Thêm link nhanh trong Cài đặt → Chung để người dùng bình chọn/đề xuất ngôn ngữ tiếp theo trên GitHub Discussions
- **Kiểm tra cập nhật app từ system tray** - Thêm hành động mới trong tray để kiểm tra cập nhật Youwee trực tiếp

- **Sinh lệnh subtitle/merge ổn định hơn** - Luồng tạo lệnh Processing ưu tiên xử lý deterministic cho chèn phụ đề và ghép nhiều video (bao gồm gợi ý thứ tự intro/outro) trước khi fallback sang AI
- **Đổi tên mục kiểm tra kênh trong tray cho rõ nghĩa** - Đổi "Kiểm tra tất cả" thành "Kiểm tra kênh theo dõi ngay" để thể hiện đúng hành vi kiểm tra các kênh đã theo dõi
- **Đơn giản hóa tiêu đề trang** - Bỏ icon phía trước tiêu đề ở các trang Metadata, Processing và AI Summary để giao diện gọn hơn

### Sửa lỗi

- **Lỗi lấy thông tin video khi dùng xác thực/proxy** - Sửa thứ tự tham số yt-dlp để cờ cookie và proxy được chèn trước dấu phân tách URL `--`, tránh lỗi `Failed to fetch video info` trong khi luồng tải video vẫn hoạt động đúng
- **Kênh Stable luôn báo có bản cập nhật** - Sửa logic kiểm tra cập nhật yt-dlp cho stable/nightly để đọc phiên bản thực từ binary đã cài (`--version`) thay vì chỉ dựa vào metadata tồn tại file, giúp hiển thị đúng trạng thái "Đã cập nhật" sau khi cập nhật xong
- **Trạng thái cập nhật Bundled và binary đang dùng không đồng bộ** - Sửa luồng cập nhật bundled để hiển thị phiên bản mới có sẵn trong Settings và ưu tiên dùng binary `app_data/bin/yt-dlp` đã cập nhật khi có, giúp cập nhật bundled có hiệu lực thực tế
- **Làm mới phần thông tin video ở trang Processing** - Thiết kế lại khu vực dưới player theo kiểu YouTube với tiêu đề nổi bật và chip metadata hiện đại, đồng thời bỏ đổi màu hover và shadow ở badge codec để giao diện gọn hơn
- **Dropdown Prompt Templates không tự đóng** - Sửa dropdown Prompt Templates ở Processing để tự đóng khi click ra ngoài hoặc nhấn phím Escape
- **Hiển thị trùng số URL ở Universal** - Sửa badge số lượng URL trong ô nhập Universal bị lặp số (ví dụ `1 1 URL`)

## [0.9.3] - 2026-02-14

- **Tải phụ đề trong Metadata** - Thêm nút chuyển đổi phụ đề trong thanh cài đặt Metadata để tải phụ đề (thủ công + tự động tạo) cùng với metadata. Bao gồm popover để chọn ngôn ngữ và định dạng (SRT/VTT/ASS)

- **Cải thiện UX nhập thời gian cắt video** - Thay thế ô nhập text thường bằng ô nhập tự động định dạng, tự chèn `:` khi gõ (ví dụ `1030` → `10:30`, `10530` → `1:05:30`). Placeholder thông minh hiển thị `M:SS` hoặc `H:MM:SS` dựa theo độ dài video. Kiểm tra realtime với viền đỏ khi định dạng sai hoặc thời gian bắt đầu >= kết thúc. Hiện tổng thời lượng video khi có

## [0.9.2] - 2026-02-13

- **Tải video theo phân đoạn thời gian** - Chỉ tải một đoạn video bằng cách đặt thời gian bắt đầu và kết thúc (ví dụ: 10:30 đến 14:30). Có thể cài đặt cho từng video trên cả hàng đợi YouTube và Universal qua biểu tượng kéo. Sử dụng `--download-sections` của yt-dlp
- **Tự động kiểm tra cập nhật FFmpeg khi khởi động** - Kiểm tra cập nhật FFmpeg giờ chạy tự động khi mở app (cho bản cài đặt tích hợp). Nếu có bản cập nhật, sẽ hiển thị trong Cài đặt > Phụ thuộc mà không cần bấm nút làm mới

## [0.9.1] - 2026-02-13

### Sửa lỗi

- **Ứng dụng crash trên macOS không có Homebrew** - Sửa lỗi crash khi khởi động do thiếu thư viện động `liblzma`. Crate `xz2` giờ dùng static linking, giúp ứng dụng hoàn toàn độc lập không cần Homebrew hay thư viện hệ thống
- **Tự động tải bỏ qua cài đặt người dùng** - Tự động tải kênh giờ áp dụng cài đặt riêng cho mỗi kênh (chế độ Video/Âm thanh, chất lượng, định dạng, codec, bitrate) thay vì dùng giá trị mặc định. Mỗi kênh có cài đặt tải riêng có thể cấu hình trong bảng cài đặt kênh
- **Tăng cường bảo mật** - FFmpeg giờ dùng mảng tham số thay vì parse chuỗi shell, chặn command injection. Thêm validate URL scheme và `--` separator cho mọi lệnh yt-dlp để chặn option injection. Bật Content Security Policy, xóa quyền shell thừa, và thêm `isSafeUrl` cho các link hiển thị
- **Lỗi preview video với container MKV/AVI/FLV/TS** - Phát hiện preview giờ kiểm tra cả container và codec. Video trong container không hỗ trợ (MKV, AVI, FLV, WMV, TS, WebM, OGG) được tự động transcode sang H.264. HEVC trong MP4/MOV không còn bị transcode thừa trên macOS
- **Hẹn giờ tải không hiển thị khi thu nhỏ vào tray** - Thông báo desktop giờ hiển thị khi tải hẹn giờ bắt đầu, dừng hoặc hoàn thành trong khi ứng dụng thu nhỏ vào system tray. Menu tray hiển thị trạng thái hẹn giờ (vd: "YouTube: 23:00"). Hẹn giờ hoạt động trên cả trang YouTube và Universal
- **Thoát từ tray hủy download đang chạy** - Nút "Thoát" trên tray giờ dùng tắt an toàn thay vì kill process, cho phép download đang chạy hoàn tất cleanup và tránh file bị hỏng
- **Cài đặt ẩn Dock bị mất khi khởi động lại (macOS)** - Tùy chọn "Ẩn biểu tượng Dock khi đóng" giờ được đồng bộ với native layer khi khởi động app, không chỉ khi vào trang Cài đặt
- **Hàng đợi Universal hiện skeleton thay vì URL khi đang tải** - Thay thế placeholder skeleton nhấp nháy bằng URL thực tế và badge spinner "Đang tải thông tin...". Khi lấy metadata thất bại, item giờ thoát trạng thái loading thay vì hiện skeleton mãi mãi

## [0.9.0] - 2026-02-12

- **Theo dõi kênh & Tải tự động** - Theo dõi các kênh YouTube, duyệt video, chọn và tải hàng loạt với đầy đủ tùy chọn chất lượng/codec/định dạng. Polling nền phát hiện video mới với thông báo desktop và badge đếm video mới theo kênh. Panel kênh theo dõi thu gọn được, hỗ trợ thu nhỏ xuống system tray
- **Xác nhận xem trước file lớn** - Ngưỡng kích thước file có thể cấu hình (mặc định 300MB) hiển thị hộp thoại xác nhận trước khi tải video lớn trong trang Xử lý. Điều chỉnh ngưỡng tại Cài đặt → Chung → Xử lý
- **Tìm kiếm cài đặt đa ngôn ngữ** - Tìm kiếm trong cài đặt giờ hoạt động với mọi ngôn ngữ. Tìm bằng tiếng Việt (ví dụ "giao diện") hoặc tiếng Trung đều cho kết quả. Từ khóa tiếng Anh vẫn hoạt động như dự phòng

### Sửa lỗi

- **Trang Xử lý bị trắng màn hình với video 4K VP9/AV1/HEVC (Linux)** - Bộ giải mã AAC của GStreamer gây crash WebKitGTK khi phát video VP9/AV1/HEVC. Preview giờ dùng phương pháp dual-element: video H.264 không âm thanh + file WAV riêng biệt đồng bộ qua JavaScript, hoàn toàn bỏ qua đường dẫn AAC bị lỗi. Nếu phát video vẫn thất bại, tự động chuyển sang ảnh thu nhỏ JPEG tĩnh. Hoạt động trên macOS, Windows và Linux

## [0.8.2] - 2026-02-11

- **Ghi chú cập nhật đa ngôn ngữ** - Hộp thoại cập nhật hiển thị ghi chú phát hành theo ngôn ngữ người dùng (Tiếng Anh, Tiếng Việt, Tiếng Trung). CI tự động trích xuất nhật ký thay đổi từ các file CHANGELOG theo ngôn ngữ
- **Tùy chọn chất lượng 8K/4K/2K cho Universal** - Dropdown chất lượng giờ có thêm 8K Ultra HD, 4K Ultra HD và 2K QHD, giống như tab YouTube. Tự động chuyển sang chất lượng cao nhất có sẵn nếu nguồn không hỗ trợ
- **Nút bật/tắt "Phát từ đầu" cho Universal** - Nút mới trong Cài đặt nâng cao để ghi live stream từ đầu thay vì từ thời điểm hiện tại. Sử dụng flag `--live-from-start` của yt-dlp
- **Xem trước video cho Universal** - Tự động hiển thị thumbnail, tiêu đề, thời lượng và kênh khi thêm URL từ TikTok, Bilibili, Facebook, Instagram, Twitter và các trang khác. Thumbnail cũng được lưu vào Thư viện
- **Nhận diện nền tảng thông minh hơn** - Thư viện giờ nhận diện và gắn nhãn chính xác hơn 1800 trang web được yt-dlp hỗ trợ (Bilibili, Dailymotion, SoundCloud, v.v.) thay vì hiển thị "Khác". Thêm tab lọc Bilibili

### Sửa lỗi

- **Trang Xử lý bị treo khi upload video (Linux)** - File video được đọc toàn bộ vào RAM qua `readFile()`, gây tràn bộ nhớ và màn hình trắng. Giờ sử dụng giao thức asset của Tauri để stream video trực tiếp mà không cần tải vào bộ nhớ. Thêm Error Boundary để ngăn màn hình trắng, xử lý lỗi video với thông báo cụ thể theo codec, dọn dẹp blob URL chống rò rỉ bộ nhớ, và nhận dạng MIME type đúng cho các định dạng không phải MP4
- **Thumbnail bị lỗi trong Thư viện** - Sửa thumbnail từ các trang như Bilibili sử dụng URL HTTP. Thumbnail giờ hiển thị biểu tượng thay thế khi không tải được
- **Thư viện không làm mới khi chuyển trang** - Thư viện giờ tự động tải dữ liệu mới nhất khi chuyển đến trang thay vì phải làm mới thủ công























