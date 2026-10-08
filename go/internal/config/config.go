package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config 结构体对应配置文件字段
type Config struct {
	Port int `yaml:"PORT"`
	// TrustProxy 是否信任反向代理下发的客户端 IP 头
	// （CF-Connecting-IP / X-Real-IP / X-Forwarded-For）。
	//
	// 该字段是**可选**的：省略时以页面设置（Settings 表的 trust_proxy）为准，
	// 因此单二进制部署无需创建/修改配置文件，直接在后台「安全设置」中开关即可。
	// 若在此显式配置，则优先于页面设置；环境变量 TRUST_PROXY 优先级最高。
	TrustProxy *bool `yaml:"TRUST_PROXY,omitempty"`
}

var GlobalConfig *Config

// DefaultConfig 默认配置。注意不要在此填写 TrustProxy，
// 否则生成的配置文件会固定覆盖页面设置。
func DefaultConfig() *Config {
	return &Config{
		Port: 3000,
	}
}

func parseBoolEnv(value string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "1", "yes", "on":
		return true, true
	case "false", "0", "no", "off":
		return false, true
	default:
		return false, false
	}
}

// EnvTrustProxy 读取环境变量 TRUST_PROXY；未设置或无法解析时返回 nil
func EnvTrustProxy() *bool {
	raw := strings.TrimSpace(os.Getenv("TRUST_PROXY"))
	if raw == "" {
		return nil
	}
	if v, ok := parseBoolEnv(raw); ok {
		return &v
	}
	return nil
}

// ResolveTrustProxy 解析生效的开关及其来源。
// 返回的 source 为 "env" / "config"；返回 nil 表示由页面设置（数据库）决定。
func (c *Config) ResolveTrustProxy() (*bool, string) {
	if v := EnvTrustProxy(); v != nil {
		return v, "env"
	}
	if c != nil && c.TrustProxy != nil {
		return c.TrustProxy, "config"
	}
	return nil, ""
}

// applyEnvOverrides 环境变量优先于配置文件
func applyEnvOverrides(cfg *Config) {
	if envPort := os.Getenv("PORT"); envPort != "" {
		if p, err := strconv.Atoi(envPort); err == nil {
			cfg.Port = p
		}
	}
}

// LoadConfig 加载或初始化配置文件
func LoadConfig() (*Config, error) {
	configPath := "./config/config.yaml"

	dir := filepath.Dir(configPath)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		os.MkdirAll(dir, 0755)
	}

	// 如果文件不存在，创建并写入默认配置
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		defaultCfg := DefaultConfig()
		applyEnvOverrides(defaultCfg)
		data, err := yaml.Marshal(defaultCfg)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(configPath, data, 0644); err != nil {
			return nil, err
		}
		GlobalConfig = defaultCfg
		return defaultCfg, nil
	}

	// 读取现有文件
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, err
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}

	applyEnvOverrides(&cfg)

	GlobalConfig = &cfg
	return &cfg, nil
}
