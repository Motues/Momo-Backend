package utils

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"

	"github.com/jmoiron/sqlx"
	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

const (
	DefaultAdminName     = "momo"
	DefaultAdminPassword = "momo"
)

var (
	settingsDB   *sqlx.DB
	settingsOnce sync.Once
)

var allowedSettings = map[string]bool{
	"site_name":             true,
	"admin_email":           true,
	"admin_name":            true,
	"smtp_host":             true,
	"smtp_port":             true,
	"email_user":            true,
	"email_password":        true,
	"email_secure":          true,
	"allow_origin":          true,
	"email_enabled":         true,
	"reply_template":        true,
	"notification_template": true,
	"comment_auto_approve":  true,
	"ip_blacklist":          true,
	"email_blacklist":       true,
	"blogger_badge_enabled": true,
	"blogger_badge_text":    true,
}

func InitSettingsDB(db *sqlx.DB) {
	settingsOnce.Do(func() {
		settingsDB = db
	})
}

func GetSetting(key string) string {
	if settingsDB == nil {
		return ""
	}
	var value string
	err := settingsDB.Get(&value, "SELECT value FROM Settings WHERE key = ?", key)
	if err != nil {
		return ""
	}
	return value
}

func SetSetting(key, value string) error {
	if settingsDB == nil {
		return fmt.Errorf("settings DB not initialized")
	}
	_, err := settingsDB.Exec(
		`INSERT INTO Settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, value,
	)
	return err
}

func GetAllSettings() map[string]string {
	result := make(map[string]string)
	if settingsDB == nil {
		return result
	}

	type row struct {
		Key   string `db:"key"`
		Value string `db:"value"`
	}

	var rows []row
	if err := settingsDB.Select(&rows, "SELECT key, value FROM Settings"); err != nil {
		return result
	}

	for _, r := range rows {
		result[r.Key] = r.Value
	}
	return result
}

func IsDefaultAdmin() bool {
	return GetSetting("password_changed") != "true"
}

func CheckAdminCredentials(name, password string) bool {
	dbName := GetSetting("admin_name")
	dbPass := GetSetting("admin_password")

	if dbName != "" && dbPass != "" {
		// bcrypt hash 检测（三端统一为 $2 前缀，避免明文以 $ 开头时被永久拒绝登录）
		if strings.HasPrefix(dbPass, "$2") {
			// 哈希分支同样必须校验用户名：否则同一密码可用任意用户名登录，
			// 并产生多个并存的会话
			if name != dbName {
				return false
			}
			err := bcrypt.CompareHashAndPassword([]byte(dbPass), []byte(password))
			return err == nil
		}
		// 明文兼容 + 自动升级为 hash
		if name == dbName && password == dbPass {
			hashed, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
			if err == nil {
				SetSetting("admin_password", string(hashed))
			}
			return true
		}
		return false
	}

	cfgName := DefaultAdminName
	cfgPass := DefaultAdminPassword

	return name == cfgName && password == cfgPass
}

func ChangeAdminPassword(name, password string) error {
	hashed, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}
	if err := SetSetting("admin_name", name); err != nil {
		return err
	}
	if err := SetSetting("admin_password", string(hashed)); err != nil {
		return err
	}
	if err := SetSetting("password_changed", "true"); err != nil {
		return err
	}
	return nil
}

func IsEmailEnabled() bool {
	enabled := GetSetting("email_enabled")
	return enabled != "false"
}

func GetTemplate(key, fallback string) string {
	t := GetSetting(key)
	if t == "" {
		return fallback
	}
	return t
}

// CheckIPBlacklist 检查 IP 是否在黑名单中（支持 CIDR）
func CheckIPBlacklist(ip string) bool {
	raw := GetSetting("ip_blacklist")
	if raw == "" {
		return false
	}
	var list []string
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		// 配置损坏：保持放行（避免因一条坏配置导致全站无法评论），但必须留下告警
		log.Printf("[WARN] ip_blacklist 不是合法 JSON，黑名单检查已被跳过，请在后台修复该配置: %v", err)
		return false
	}
	for _, entry := range list {
		if entry == ip {
			return true
		}
		if _, cidr, err := net.ParseCIDR(entry); err == nil {
			if cidr.Contains(net.ParseIP(ip)) {
				return true
			}
		}
	}
	return false
}

// IsValidIpOrCidr 校验单条黑名单条目是否为合法 IP 或 CIDR
func IsValidIpOrCidr(entry string) bool {
	value := strings.TrimSpace(entry)
	if value == "" {
		return false
	}
	if !strings.Contains(value, "/") {
		return net.ParseIP(value) != nil
	}
	_, _, err := net.ParseCIDR(value)
	return err == nil
}

// ValidateIPBlacklistJSON 校验黑名单 JSON 字符串（必须是数组且每项为合法 IP/CIDR）
func ValidateIPBlacklistJSON(raw string) bool {
	if raw == "" {
		return true
	}
	var list []string
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return false
	}
	for _, entry := range list {
		if !IsValidIpOrCidr(entry) {
			return false
		}
	}
	return true
}

// IsValidCommentStatus 评论状态枚举白名单
func IsValidCommentStatus(status string) bool {
	switch status {
	case "pending", "approved", "rejected", "deleted":
		return true
	default:
		return false
	}
}

// CheckEmailBlacklist 检查邮箱是否在黑名单中（不区分大小写）
func CheckEmailBlacklist(email string) bool {
	raw := GetSetting("email_blacklist")
	if raw == "" {
		return false
	}
	var list []string
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		log.Printf("[WARN] email_blacklist 不是合法 JSON，黑名单检查已被跳过，请在后台修复该配置: %v", err)
		return false
	}
	for _, entry := range list {
		if strings.EqualFold(entry, email) {
			return true
		}
	}
	return false
}

// GetCommentStatus 根据设置返回评论状态（pending/approved）
func GetCommentStatus() string {
	val := GetSetting("comment_auto_approve")
	if val == "false" {
		return "pending"
	}
	return "approved"
}
