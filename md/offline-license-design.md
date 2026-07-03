# AiPen 离线许可证系统设计文档

> 纯手工激活 · 零服务器 · 50 元/年 · 2 天试用 · 防时间作弊 · 简单防逆向

---

## 一、架构总览

```
┌──────────────────────┐        微信         ┌──────────────────┐
│     用户机器          │ ──── 机器码 ────→   │   开发者(你)      │
│                      │                     │                  │
│  AiPen 客户端        │ ←─── 许可证 ────    │  license-gen CLI │
│  ├ 公钥 (内置)       │                     │  ├ 私钥 (本地)   │
│  ├ 许可证验证        │                     │  └ Ed25519 签名  │
│  ├ 时间防作弊引擎    │                     └──────────────────┘
│  ├ 试用/到期管理     │
│  └ UI: 激活/提醒     │
└──────────────────────┘
```

**核心原则**：许可证含到期时间 + 开发者私钥签名 → 客户端用内置公钥验签 → 时间和内容均不可篡改。

---

## 二、机器码生成

### 2.1 指纹采集

```rust
// 依赖: machine-uid, sha2
fn generate_machine_code() -> String {
    let mid = machine_uid::get().unwrap_or_default();
    let mac = get_mac_address().unwrap_or_default();
    let disk = get_disk_serial().unwrap_or_default();

    let raw = format!("{mid}:{mac}:{disk}");
    let hash = sha2::Sha256::digest(raw.as_bytes());
    // 输出 12 字符小写十六进制
    hex::encode(&hash)[..12].to_string()
}
```

### 2.2 容错设计

- 任一来源变化（如更换网卡）时，其他来源不变 → 可重新计算匹配
- 机器码仅用于标识设备，不作为安全密钥，安全依赖 Ed25519 签名

---

## 三、许可证格式与签名

### 3.1 许可证结构

```
{机器码}.{到期时间}.{base64(Ed25519签名)}

示例:
abc123def456.2028-06-28T00:00:00.Wl0jfi23FWAaDs9nDdGfx7Q1kLBcM2pZ...
```

| 字段 | 说明 | 长度 |
|------|------|------|
| 机器码 | 设备指纹 | 12 字符 |
| 到期时间 | ISO 8601 格式（UTC） | 19 字符 |
| 签名 | Ed25519 签名，base64 编码 | ~88 字符 |
| **分隔符** | `.` | |
| **总长约** | ~120 字符 | 方便微信发送 |

### 3.2 签名原理

```
payload = machine_code + "." + expiry
signature = ed25519_sign(private_key, payload)
license  = payload + "." + base64(signature)
```

- 开发者持有 **Ed25519 私钥**（永不离开你的电脑，丢失后无法补签）
- 客户端内置 **Ed25519 公钥**（32 字节，编译进 Rust 二进制）
- 客户端验证：`ed25519_verify(public_key, payload, signature)`
- 无需联网即可验证签名真伪

### 3.3 Rust 依赖

```toml
# Cargo.toml
[dependencies]
ed25519-dalek = "2"
ring = "0.17"            # AEAD 加密本地存储
sha2 = "0.10"
hex = "0.4"
base64 = "0.22"
machine-uid = "0.5"
mac_address = "0.1"
rand = "0.8"
```

---

## 四、客户端许可证引擎

### 4.1 状态定义

```rust
#[derive(Serialize, Deserialize)]
enum LicensePhase {
    Trial { started_at: i64 },           // 试用中
    Activated { expiry: i64 },           // 已激活
    ExpiringSoon { remaining_days: i32 }, // 即将到期
    Expired,                             // 已过期
}

#[derive(Serialize, Deserialize)]
struct LicenseState {
    phase: LicensePhase,
    machine_code: String,
    last_seen_time: i64,       // 时间倒流检测（只增不减）
    cumulative_seconds: u64,   // 累计使用时长（单调时钟）
    checksum: [u8; 32],        // 防篡改校验
}
```

### 4.2 许可证验证流程

```
启动应用
    │
    ▼
加载加密的 LicenseState
    │
    ▼
┌─────────────────────┐
│ 校验 checksum       │ ← 防篡改
│ fail → Expired       │
└────────┬────────────┘
         │ pass
         ▼
┌─────────────────────┐
│ 时间倒流检测         │ ← last_seen_time >= now ?
│ fail → Expired       │
└────────┬────────────┘
         │ pass
         ▼
    有许可证？
    /         \
  是            否
  │             │
  ▼             ▼
验证签名     ┌─ 首次？
│            /     \
│  pass?    是      否
│  /   \    │       │
│ 是    否  ▼       ▼
│ │     │ 写入    已过期?
│ ▼     │ 试用     /   \
│ 检查   │ 起始    是   否
│ 到期   │ 时间    │    │
│        │        ▼    ▼
│        │     Expired Trial
│        │
│  ┌─────┴─────┐
│  │ 到期时间  │
│  │ vs 当前   │
│  └─────┬─────┘
│   /         \
│  过期       有效
│   │          │
│   ▼          │
│ ┌──────────┐ │
│ │剩余≤2天? │ │
│ │/        \│ │
│ │是       否│ │
│ ││         ││
│ │▼         ││
│ │Expiring  ││
│ │Soon      │▼
│ │       Activated
│ ▼
│ Expired
│
▼
启动对应 UI
```

### 4.3 时间防作弊（三重防御）

#### Layer 1：时间倒流检测

```rust
fn check_time_rollback(state: &mut LicenseState) -> Result<(), LicenseError> {
    let now = chrono::Utc::now().timestamp();
    if now < state.last_seen_time {
        // 时间倒流！用户改了系统时间
        return Err(LicenseError::TimeRollback);
    }
    state.last_seen_time = now;
    save_state(state);
    Ok(())
}
```

- `last_seen_time` 只增不减
- 一旦时间向前走过，倒退即被封
- 每次启动、每次操作前都检查

#### Layer 2：累计使用时长

```rust
struct UsageTracker {
    cumulative_seconds: u64,
    session_start: Instant,  // std::time::Instant —— OS 单调时钟
}

impl UsageTracker {
    fn on_shutdown(&mut self, state: &mut LicenseState) {
        let elapsed = self.session_start.elapsed().as_secs();
        state.cumulative_seconds += elapsed;
        save_state(state);
    }
}
```

- 使用 `std::time::Instant`（不受系统时间修改影响、不会倒退）
- 每次关闭时把本次 session 的用量累加到加密存储
- 破解思路：用户永不停在激活日 → 用量会异常偏大 → 设一个异常阈值

#### Layer 3：锚点校验

```rust
fn sanity_check(activation_time: i64) -> bool {
    // 1. 系统关键文件创建时间作为时间锚点
    let anchor = get_system_file_ctime(); // e.g. C:\Windows\explorer.exe
    if activation_time < anchor - 365 * 86400 {
        return false; // 比系统文件早一年？不现实
    }

    // 2. SQLite 数据库创建时间
    let db_ctime = std::fs::metadata("data.db")?.created()?.duration_since(UNIX_EPOCH).as_secs();
    // 激活时间不应该早于数据库创建时间 + 合理偏差
    if activation_time < db_ctime - 2 * 86400 {
        return false;
    }

    true
}
```

#### 防作弊效果汇总

| 用户操作 | Layer 1 | Layer 2 | Layer 3 | 结果 |
|----------|:-------:|:-------:|:-------:|------|
| 改系统时间往前 | ✅ | — | — | 无法绕过 |
| 改系统时间往回 | ❌ | — | — | 拦截 |
| 永远停在激活日 | ✅ 放过 | ❌ 兜住 | ✅ 放过 | 拦截（用量异常） |
| 重装系统 | 重置 | 重置 | ✅ 放过 | 重新激活（绑定机器码不变） |
| 每天改未来1天 | ❌ | ✅ 放过 | — | 拦截 |
| 虚拟机新装 | 重置 | 重置 | — | 重新激活（机器码不同） |

---

## 五、试用机制

### 5.1 首次启动

```rust
fn start_trial(state: &mut LicenseState) {
    let now = chrono::Utc::now().timestamp();
    state.phase = LicensePhase::Trial { started_at: now };
    state.last_seen_time = now;
    save_state(state);
}
```

### 5.2 试用倒计时

```rust
fn check_trial(state: &LicenseState) -> TrialStatus {
    let now = chrono::Utc::now().timestamp();
    let elapsed = now - state.trial_start;
    let remaining = 2 * 86400 - elapsed;

    match remaining {
        r if r <= 0 => TrialStatus::Expired,
        r if r < 86400 => TrialStatus::ExpiringSoon { hours_left: r / 3600 },
        _ => TrialStatus::Active { hours_left: remaining / 3600 },
    }
}
```

### 5.3 UI 表现

| 阶段 | 界面 |
|------|------|
| 试用中（剩余 > 1 天） | 启动弹窗 "试用版，剩余 X 天"，可关闭继续使用 |
| 试用最后 1 天 | 启动弹窗 "试用将在 X 小时后到期"，黄色横幅常驻 |
| 试用到期 | 锁定主界面，仅显示激活窗口 |
| 已激活（> 2 天到期） | 无提示，正常使用 |
| 到期前 2 天 | 启动弹窗 + 底部黄色横幅 "许可证将在 2 天后到期，请续费" |
| 已过期 | 锁定主界面，仅显示激活窗口 |

---

## 六、前端 UI 设计

### 6.1 激活窗口

```
┌──────────────────────────────────────┐
│         AiPen 许可证激活              │
│                                      │
│  您的机器码:                         │
│  ┌──────────────────────────────┐    │
│  │ abc123def456          [复制] │    │
│  └──────────────────────────────┘    │
│                                      │
│  ┌ 微信扫码添加开发者 ─────────┐     │
│  │                              │     │
│  │         [你的微信二维码]      │     │
│  │                              │     │
│  └──────────────────────────────┘     │
│                                      │
│  步骤:                               │
│  1. 发送上方机器码给开发者            │
│  2. 转账 50 元 (一年使用期)          │
│  3. 收到许可证后粘贴到下方            │
│                                      │
│  许可证:                             │
│  ┌──────────────────────────────┐    │
│  │ 粘贴许可证字符串...           │    │
│  └──────────────────────────────┘    │
│                                      │
│         [ 激活 ]                     │
│                                      │
└──────────────────────────────────────┘
```

### 6.2 到期提醒横幅

```html
<!-- 主界面底部横幅 -->
<div v-if="phase === 'ExpiringSoon'" class="expiry-banner">
  ⚠️ 您的许可证将在 {{ remainingDays }} 天后到期，请续费。
  点击查看 [激活/续费页面]
</div>
```

### 6.3 试用到期 / 许可证过期界面

- 全屏遮罩锁定所有功能
- 仅显示激活窗口（6.1）
- 试用到期与许可证过期的界面相同，区别仅在于提示文案

---

## 七、开发者工具箱：license-gen

### 7.1 功能

一个本地命令行工具，仅供开发者使用：

```bash
# 生成一年期许可证
$ license-gen --machine abc123def456 --expiry 2028-06-28

# 输出
许可证: abc123def456.2028-06-28T00:00:00.Wl0jfi23FWAaDs9nDdGfx7Q1kLBcM2pZth9Ry...

# 生成试用续期许可证（给新用户延期）
$ license-gen --machine abc123def456 --days 7
许可证: abc123def456.2028-07-05T00:00:00.Xk2mgG34GWAbEt0oEeHgy8R2mMCdN3qAui0Sz...
```

### 7.2 项目结构

```
license-gen/
├── Cargo.toml
├── src/
│   └── main.rs
└── private_key.txt       # ⚠️ 私钥文件，gitignore，永不提交！
```

### 7.3 核心代码

```rust
// license-gen/src/main.rs
use clap::Parser;
use ed25519_dalek::{Signer, SigningKey};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{Utc, Duration};

#[derive(Parser)]
struct Args {
    #[arg(long)]
    machine: String,

    #[arg(long)]
    expiry: Option<String>,   // ISO 8601, e.g. 2028-06-28

    #[arg(long)]
    days: Option<i64>,        // 从今天起 N 天，e.g. 365
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    let expiry = match (args.expiry, args.days) {
        (Some(e), _) => e,
        (_, Some(d)) => {
            let date = Utc::now() + Duration::days(d);
            date.format("%Y-%m-%dT00:00:00").to_string()
        }
        _ => {
            eprintln!("请指定 --expiry 或 --days");
            std::process::exit(1);
        }
    };

    // 加载私钥
    let private_key_hex = std::fs::read_to_string("private_key.txt")?.trim().to_string();
    let private_key_bytes = hex::decode(private_key_hex)?;
    let signing_key = SigningKey::from_bytes(
        &private_key_bytes.try_into().map_err(|_| "invalid key length")?
    );

    // 签名
    let payload = format!("{}.{}", args.machine, expiry);
    let signature = signing_key.sign(payload.as_bytes());
    let signature_b64 = BASE64.encode(signature.to_bytes());

    // 输出许可证
    let license = format!("{}.{}", payload, signature_b64);
    println!("许可证: {license}");
    println!();
    println!("到期时间: {expiry}");
    println!("机器码:   {}", args.machine);

    Ok(())
}
```

### 7.4 密钥生成（一次性操作）

```rust
// 首次运行，生成密钥对（只做一次）
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;

fn generate_keys() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();

    // 私钥 → 保存到 private_key.txt（绝密，不分享）
    let private_hex = hex::encode(signing_key.to_bytes());
    std::fs::write("private_key.txt", &private_hex).unwrap();

    // 公钥 → 复制到 AiPen 源码中
    let public_base64 = base64::encode(verifying_key.as_bytes());
    println!("公钥（粘贴到 AiPen 源码）: {public_base64}");
}
```

---

## 八、AiPen 客户端核心实现

### 8.1 文件结构

```
src-tauri/src/
├── license/
│   ├── mod.rs          // 模块入口
│   ├── engine.rs       // 许可证验证引擎
│   ├── time_guard.rs   // 时间防作弊
│   ├── storage.rs      // 加密本地存储
│   └── vm_validator.rs // 自定义 VM 混淆验证（可选）
├── lib.rs
└── commands.rs         // Tauri commands 导出
```

### 8.2 许可证验证引擎

```rust
// license/engine.rs
use ed25519_dalek::{Verifier, VerifyingKey};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

const PUBLIC_KEY_B64: &str = "你的公钥base64，keygen生成后贴在这里";

pub struct License {
    pub machine_code: String,
    pub expiry: i64,      // unix timestamp
    pub raw: String,
}

impl License {
    pub fn parse(license_str: &str) -> Result<Self, LicenseError> {
        let parts: Vec<&str> = license_str.split('.').collect();
        if parts.len() != 3 {
            return Err(LicenseError::InvalidFormat);
        }

        let machine_code = parts[0].to_string();
        let expiry_str = parts[1];
        let signature_b64 = parts[2];

        // 验证签名
        let payload = format!("{machine_code}.{expiry_str}");
        let signature_bytes = BASE64.decode(signature_b64)?;
        let signature = ed25519_dalek::Signature::from_bytes(
            &signature_bytes.try_into().map_err(|_| LicenseError::InvalidSignature)?
        );

        let public_key_bytes = BASE64.decode(PUBLIC_KEY_B64)?;
        let public_key = VerifyingKey::from_bytes(
            &public_key_bytes.try_into().map_err(|_| LicenseError::InvalidPublicKey)?
        );

        public_key.verify(payload.as_bytes(), &signature)?;

        // 验证机器码匹配
        let current_machine = get_machine_code();
        if machine_code != current_machine {
            return Err(LicenseError::MachineCodeMismatch);
        }

        let expiry = chrono::DateTime::parse_from_rfc3339(
            &format!("{expiry_str}+00:00")
        )?.timestamp();

        Ok(License { machine_code, expiry, raw: license_str.to_string() })
    }
}
```

### 8.3 加密存储

```rust
// license/storage.rs
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};

// 加密密钥：从公钥派生（公钥已在二进制中，无需额外存储）
// 或使用固定密钥（编译时注入）
const STORAGE_KEY: &[u8; 32] = include_bytes!("../../storage_key.bin");

pub fn save_state(state: &LicenseState) -> Result<(), std::io::Error> {
    let json = serde_json::to_vec(state)?;

    let unbound_key = UnboundKey::new(&AES_256_GCM, STORAGE_KEY)?;
    let key = LessSafeKey::new(unbound_key);

    let mut nonce_bytes = [0u8; 12];
    SystemRandom::new().fill(&mut nonce_bytes)?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let mut encrypted = json.clone();
    encrypted.extend_from_slice(&[0; 16]); // GCM tag space
    key.seal_in_place_append_tag(nonce, Aad::empty(), &mut encrypted)?;

    // 写入: nonce(12) + ciphertext+tag
    let mut file = std::fs::File::create(get_state_path())?;
    file.write_all(&nonce_bytes)?;
    file.write_all(&encrypted)?;
    Ok(())
}

pub fn load_state() -> Option<LicenseState> {
    let mut file = std::fs::File::open(get_state_path()).ok()?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).ok()?;
    // ... 解密逻辑
    // ... 反序列化
    // ... 校验 checksum
}
```

### 8.4 自定义 VM 混淆验证（可选，深度防逆向）

将核心验证逻辑编译为自定义字节码，运行时由内嵌 VM 解释执行：

```rust
// license/vm_validator.rs

/// 自定义指令集
#[repr(u8)]
enum Op {
    Push = 0x01,      // Push value
    VerifySig = 0x02, // 验证 ed25519 签名
    CheckExpiry = 0x03,
    CheckMachine = 0x04,
    Ret = 0xFF,
}

struct Vm {
    stack: Vec<u64>,
    pc: usize,
}

impl Vm {
    /// 执行验证字节码，返回是否通过
    fn execute(bytecode: &[u8], license_data: &LicenseInput) -> bool {
        let mut vm = Vm { stack: vec![], pc: 0 };
        loop {
            let op = bytecode[vm.pc];
            vm.pc += 1;
            match op {
                0x01 => {
                    let val = u64::from_le_bytes(bytecode[vm.pc..vm.pc+8].try_into().unwrap());
                    vm.stack.push(val);
                    vm.pc += 8;
                }
                0x02 => { /* ed25519 verify */ }
                0x03 => { /* check expiry */ }
                0x04 => { /* check machine code */ }
                0xFF => return vm.stack.last() == Some(&1),
                _ => return false,
            }
        }
    }
}

// 字节码在编译时生成（用建宏或 build.rs）
const VALIDATOR_BYTECODE: &[u8] = &[
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Push license_data
    0x02, // VerifySig
    0x03, // CheckExpiry
    0x04, // CheckMachine
    0xFF, // Ret
];
```

逆向者看到的是 `match 0x01 { ... match 0x02 { ...`，完全不知道在算什么。

---

## 九、编译配置（防逆向）

```toml
# Cargo.toml [profile.release]
[profile.release]
opt-level = "z"          # 最小体积 + 混淆
lto = "fat"              # 激进内联
codegen-units = 1        # 单编译单元
strip = "symbols"        # 剥离符号表
panic = "abort"          # 移除 unwind 表
```

配合：
- 公钥字符串使用 `obfstr` 宏加密（编译时 XOR → 运行时解密）
- 验证逻辑分散在 3+ 个函数中
- 失败症状延迟出现（不立即崩溃，而是在后续操作中产生异常）

---

## 十、完整工作流程

### 日常运营

```
1. 用户下载安装 AiPen
2. 首次打开 → 自动进入 2 天试用
3. 试用到期 → 弹出激活窗口（显示机器码 + 微信二维码）
4. 用户微信扫码添加你 → 发送机器码
5. 你收到机器码 + 50 元转账
6. 你在电脑上运行:
   $ license-gen --machine abc123def456 --days 365
   许可证: abc123def456.2028-06-28T00:00:00.Wl0jfi23FWA...

7. 复制许可证 → 微信发回用户
8. 用户粘贴到激活窗口 → 点击激活 → 验证通过 → 正常使用
9. 一年后到期前 2 天 → 启动弹窗提醒续费
```

### 续费

```
1. 用户打开 AiPen → 弹出到期提醒
2. 用户微信联系你 → 转账 50 元续费
3. 你重新运行 license-gen，更新到期时间
4. 用户输入新许可证 → 重新激活
```

### 多设备

> 一个购买 = 一个机器码，如需多设备需再购买。

---

## 十一、文件清单

| 文件 | 用途 | 是否 gitignore |
|------|------|:---:|
| `license-gen/private_key.txt` | Ed25519 私钥 | ✅ **必须** |
| `license-gen/src/main.rs` | 许可证生成器 | 否 |
| `src-tauri/src/license/mod.rs` | 许可证模块入口 | 否 |
| `src-tauri/src/license/engine.rs` | 验证引擎 | 否 |
| `src-tauri/src/license/time_guard.rs` | 时间防作弊 | 否 |
| `src-tauri/src/license/storage.rs` | 加密存储 | 否 |
| `src-tauri/src/license/vm_validator.rs` | VM 混淆验证（可选） | 否 |
| `src-tauri/src/commands.rs` | 添加 `validate_license` 等 command | 否 |
| `src/components/ActivationDialog.vue` | 激活窗口 | 否 |
| `src/components/ExpiryBanner.vue` | 到期提醒横幅 | 否 |
| `src/stores/license.ts` | 前端许可证状态管理 (Pinia) | 否 |

---

## 十二、开发顺序建议

| 阶段 | 内容 | 预估时间 |
|------|------|----------|
| 1 | `license-gen` CLI 工具 + 密钥对生成 | 30 分钟 |
| 2 | `license/engine.rs` 许可证验证 | 1 小时 |
| 3 | `license/time_guard.rs` 时间防作弊 | 1 小时 |
| 4 | `license/storage.rs` 加密存储 | 1 小时 |
| 5 | Tauri commands 集成 | 30 分钟 |
| 6 | 前端 UI（激活窗口 + 试用横幅 + 提醒） | 2 小时 |
| 7 | 集成测试 + 时间作弊测试 | 1 小时 |
| 8 | （可选）VM 混淆验证 | 2 小时 |

**总计**：约 1-2 天。

---

## 附录 A：私钥安全

- ⚠️ `private_key.txt` **绝对不能**提交到 git 仓库
- ⚠️ **绝对不能**发给任何人
- ⚠️ 私钥丢失 → **所有已签发许可证全部作废**，需重新发版更换公钥
- ✅ 建议加密备份（PGP / Veracrypt / 纸笔记录十六进制）

## 附录 B：破解难度评估

| 防御层 | 防小白 | 防程序员 | 防逆向者 |
|--------|:---:|:---:|:---:|
| 时间倒流检测 | ✅ | ✅ | ⚠️ 可定位 |
| 累计使用时长 | ✅ | ✅ | ⚠️ 可定位 |
| 锚点校验 | ✅ | ✅ | ❌ 可 patch |
| Ed25519 签名 | ✅ | ✅ | ✅ 无法伪造 |
| 符号剥离 + LTO | ✅ | ✅ | ⚠️ 增加时间 |
| 字符串加密 | ✅ | ✅ | ⚠️ 可提取 |
| 分片验证 | ✅ | ✅ | ⚠️ 可追踪 |
| 自定义 VM | ✅ | ✅ | ✅ 极高门槛 |
| VMProtect 加壳 | ✅ | ✅ | ✅ 商业级 |

> 对于 50 元软件的防御目标：基础级 + 分片 + VM 已远超同价位竞品。
