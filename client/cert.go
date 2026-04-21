package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// CertManager handles CA certificate generation, storage, and
// on-the-fly leaf certificate creation for MITM interception.
type CertManager struct {
	caCert  *x509.Certificate
	caKey   *ecdsa.PrivateKey
	dataDir string
	cache   map[string]*tls.Certificate
	mu      sync.RWMutex
}

// NewCertManager loads an existing CA or generates a new one.
func NewCertManager(dataDir string) (*CertManager, error) {
	cm := &CertManager{
		dataDir: dataDir,
		cache:   make(map[string]*tls.Certificate),
	}

	certPath := filepath.Join(dataDir, "ca.crt")
	keyPath := filepath.Join(dataDir, "ca.key")

	// Try loading existing CA
	if _, err := os.Stat(certPath); err == nil {
		cert, key, err := loadCA(certPath, keyPath)
		if err == nil {
			cm.caCert = cert
			cm.caKey = key
			return cm, nil
		}
	}

	// Generate new CA
	cert, key, err := generateCA()
	if err != nil {
		return nil, fmt.Errorf("generate CA: %w", err)
	}
	if err := saveCA(cert, key, certPath, keyPath); err != nil {
		return nil, fmt.Errorf("save CA: %w", err)
	}

	cm.caCert = cert
	cm.caKey = key
	return cm, nil
}

func generateCA() (*x509.Certificate, *ecdsa.PrivateKey, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}

	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "AI Monitor Local CA",
			Organization: []string{"AI Token Monitor"},
		},
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour), // 10 years
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            1,
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}

	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

func saveCA(cert *x509.Certificate, key *ecdsa.PrivateKey, certPath, keyPath string) error {
	cf, err := os.Create(certPath)
	if err != nil {
		return err
	}
	pem.Encode(cf, &pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})
	cf.Close()

	kb, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	kf, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	pem.Encode(kf, &pem.Block{Type: "EC PRIVATE KEY", Bytes: kb})
	kf.Close()
	return nil
}

func loadCA(certPath, keyPath string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, nil, err
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, nil, err
	}

	block, _ := pem.Decode(certPEM)
	if block == nil {
		return nil, nil, fmt.Errorf("invalid cert PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, nil, err
	}

	block, _ = pem.Decode(keyPEM)
	if block == nil {
		return nil, nil, fmt.Errorf("invalid key PEM")
	}
	key, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

const maxCertCacheSize = 1000

// GetCert returns a TLS certificate for the given hostname, generating on-the-fly if needed.
func (cm *CertManager) GetCert(hostname string) (*tls.Certificate, error) {
	cm.mu.RLock()
	if c, ok := cm.cache[hostname]; ok {
		cm.mu.RUnlock()
		return c, nil
	}
	cm.mu.RUnlock()

	cm.mu.Lock()
	defer cm.mu.Unlock()

	// Double-check after acquiring write lock
	if c, ok := cm.cache[hostname]; ok {
		return c, nil
	}

	// Evict entries if cache is full
	if len(cm.cache) >= maxCertCacheSize {
		count := 0
		for k := range cm.cache {
			delete(cm.cache, k)
			count++
			if count >= maxCertCacheSize/4 {
				break
			}
		}
	}

	c, err := cm.issueLeaf(hostname)
	if err != nil {
		return nil, err
	}
	cm.cache[hostname] = c
	return c, nil
}

func (cm *CertManager) issueLeaf(hostname string) (*tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: hostname},
		DNSNames:     []string{hostname},
		NotBefore:    time.Now().Add(-1 * time.Hour),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, cm.caCert, &key.PublicKey, cm.caKey)
	if err != nil {
		return nil, err
	}

	return &tls.Certificate{
		Certificate: [][]byte{der, cm.caCert.Raw},
		PrivateKey:  key,
	}, nil
}

// CACertPath returns the filesystem path to the CA certificate file.
func (cm *CertManager) CACertPath() string {
	return filepath.Join(cm.dataDir, "ca.crt")
}

// InstallCA installs the CA certificate to the current user's trusted root store.
func (cm *CertManager) InstallCA() error {
	switch runtime.GOOS {
	case "windows":
		// Use PowerShell Import-Certificate to avoid Windows security dialog popup
		psCmd := fmt.Sprintf(`Import-Certificate -FilePath "%s" -CertStoreLocation Cert:\CurrentUser\Root`, cm.CACertPath())
		out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", psCmd).CombinedOutput()
		if err != nil {
			// Fallback to certutil if PowerShell fails
			out2, err2 := exec.Command("certutil", "-addstore", "-user", "-f", "Root", cm.CACertPath()).CombinedOutput()
			if err2 != nil {
				return fmt.Errorf("powershell: %s; certutil: %s: %w", string(out), string(out2), err2)
			}
		}
		_ = out
		return nil
	case "darwin":
		// Without -d flag: modifies user-level Trust Settings,
		// which triggers a GUI authentication dialog automatically.
		out, err := exec.Command("security", "add-trusted-cert",
			"-r", "trustRoot",
			cm.CACertPath()).CombinedOutput()
		if err != nil {
			return fmt.Errorf("security add-trusted-cert: %s: %w", strings.TrimSpace(string(out)), err)
		}
		return nil
	default:
		return fmt.Errorf("automatic CA installation is not implemented on %s yet; trust %s manually", runtime.GOOS, cm.CACertPath())
	}
}

// UninstallCA removes the CA certificate from the user's trusted root store.
func (cm *CertManager) UninstallCA() {
	if runtime.GOOS != "windows" {
		return
	}

	// Try PowerShell first
	psCmd := `Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -like "*AI Monitor Local CA*" } | Remove-Item -Force`
	exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", psCmd).Run()
	// Also try certutil as fallback
	exec.Command("certutil", "-delstore", "-user", "Root", "AI Monitor Local CA").Run()
}
