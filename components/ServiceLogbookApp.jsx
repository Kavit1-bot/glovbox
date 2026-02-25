// Complete Service Logbook Application
// Single file with all components for easy integration

import React, { useState, useEffect } from 'react';

// ===== MAIN COMPONENT =====
export default function ServiceLogbook({ vehicle, user }) {
  const [services, setServices] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadServices();
  }, [vehicle.id]);

  async function loadServices() {
    try {
      const response = await fetch(`/api/vehicles/${vehicle.id}/services`);
      const data = await response.json();
      setServices(data.services || []);
    } catch (error) {
      console.error('Error loading services:', error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-blue-900 mb-2">
              Service History
            </h1>
            <p className="text-gray-600">
              {vehicle.make} {vehicle.model} • {vehicle.registrationNumber}
            </p>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-orange-500 text-white px-6 py-3 rounded-lg font-semibold hover:bg-orange-600 transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Service Record
          </button>
        </div>
      </div>

      {/* Maintenance Progress */}
      <MaintenanceProgress vehicle={vehicle} services={services} />

      {/* Entry Form */}
      {showForm && (
        <ServiceEntryForm 
          vehicle={vehicle}
          onSuccess={() => {
            setShowForm(false);
            loadServices();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* Timeline */}
      <ServiceTimeline services={services} loading={loading} vehicle={vehicle} />

      {/* Export Button */}
      {services.length > 0 && (
        <ExportHistoryButton vehicle={vehicle} services={services} />
      )}
    </div>
  );
}

// ===== MAINTENANCE PROGRESS COMPONENT =====
function MaintenanceProgress({ vehicle, services }) {
  const STANDARD_SERVICE_INTERVAL = 12000;
  const currentMileage = vehicle.currentMileage || 0;
  const lastServiceMileage = vehicle.lastServiceMileage || 0;
  
  const milesSinceService = currentMileage - lastServiceMileage;
  const progressPercent = Math.min((milesSinceService / STANDARD_SERVICE_INTERVAL) * 100, 100);
  const milesUntilService = Math.max(STANDARD_SERVICE_INTERVAL - milesSinceService, 0);
  const isOverdue = progressPercent >= 100;

  const totalSpent = services.reduce((sum, s) => sum + (s.totalCost || 0), 0);
  const avgCost = services.length > 0 ? (totalSpent / services.length) : 0;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <h2 className="text-xl font-bold text-blue-900 mb-6">Maintenance Overview</h2>
      
      {/* Progress Bar */}
      <div className="mb-6">
        <div className="flex justify-between items-center text-sm mb-2">
          <span className="text-gray-600 font-medium">Next service due</span>
          <span className={`font-bold ${isOverdue ? 'text-red-600' : 'text-blue-600'}`}>
            {isOverdue ? '⚠️ Service Overdue!' : `${milesUntilService.toLocaleString()} miles`}
          </span>
        </div>
        
        <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
          <div 
            className={`h-full transition-all duration-700 ${
              isOverdue ? 'bg-red-500' : 
              progressPercent > 75 ? 'bg-orange-500' : 
              'bg-green-500'
            }`}
            style={{ width: `${Math.min(progressPercent, 100)}%` }}
          />
        </div>
        
        <div className="flex justify-between text-xs text-gray-500 mt-2">
          <span>Last: {lastServiceMileage.toLocaleString()} mi</span>
          <span>{progressPercent.toFixed(0)}% of interval</span>
          <span>Due: {(lastServiceMileage + STANDARD_SERVICE_INTERVAL).toLocaleString()} mi</span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-blue-50 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-blue-900">{services.length}</div>
          <div className="text-xs text-gray-600 mt-1">Services</div>
        </div>
        <div className="bg-green-50 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-green-900">£{totalSpent.toFixed(0)}</div>
          <div className="text-xs text-gray-600 mt-1">Total Spent</div>
        </div>
        <div className="bg-purple-50 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-purple-900">£{avgCost.toFixed(0)}</div>
          <div className="text-xs text-gray-600 mt-1">Avg Cost</div>
        </div>
        <div className="bg-orange-50 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-orange-900">{currentMileage.toLocaleString()}</div>
          <div className="text-xs text-gray-600 mt-1">Current Miles</div>
        </div>
      </div>
    </div>
  );
}

// ===== SERVICE ENTRY FORM COMPONENT =====
function ServiceEntryForm({ vehicle, onSuccess, onCancel }) {
  const [formData, setFormData] = useState({
    serviceDate: new Date().toISOString().split('T')[0],
    mileageAtService: vehicle.currentMileage || '',
    garageName: '',
    garagePhone: '',
    serviceType: 'Minor Service',
    description: '',
    totalCost: '',
    notes: ''
  });
  const [receiptFile, setReceiptFile] = useState(null);
  const [receiptPreview, setReceiptPreview] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [ocrProcessing, setOcrProcessing] = useState(false);

  const serviceTypes = [
    'Major Service',
    'Minor Service',
    'MOT',
    'Repair',
    'Tyres',
    'Brake Service',
    'Oil Change',
    'Battery',
    'Exhaust',
    'Other'
  ];

  function handleFileChange(e) {
    const file = e.target.files[0];
    if (file) {
      setReceiptFile(file);
      const reader = new FileReader();
      reader.onload = (e) => setReceiptPreview(e.target.result);
      reader.readAsDataURL(file);
    }
  }

  async function processReceiptOCR() {
    if (!receiptFile) return;
    
    setOcrProcessing(true);
    const formData = new FormData();
    formData.append('receipt', receiptFile);
    
    try {
      const response = await fetch('/api/ocr/process', {
        method: 'POST',
        body: formData
      });
      const data = await response.json();
      
      if (data.success && data.data) {
        // Auto-fill form with OCR data
        if (data.data.garageName) setFormData(prev => ({...prev, garageName: data.data.garageName}));
        if (data.data.totalCost) setFormData(prev => ({...prev, totalCost: data.data.totalCost}));
        if (data.data.items && data.data.items.length > 0) {
          setFormData(prev => ({...prev, description: data.data.items.join(', ')}));
        }
        alert('✓ Receipt scanned! Check the auto-filled fields.');
      }
    } catch (error) {
      console.error('OCR Error:', error);
    } finally {
      setOcrProcessing(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setProcessing(true);

    try {
      // Upload receipt if provided
      let receiptUrl = null;
      if (receiptFile) {
        const uploadData = new FormData();
        uploadData.append('receipt', receiptFile);
        uploadData.append('vehicleId', vehicle.id);
        
        const uploadResponse = await fetch('/api/upload-receipt', {
          method: 'POST',
          body: uploadData
        });
        const uploadResult = await uploadResponse.json();
        receiptUrl = uploadResult.url;
      }

      // Save service record
      const response = await fetch(`/api/vehicles/${vehicle.id}/services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          receiptImageUrl: receiptUrl,
          totalCost: formData.totalCost ? parseFloat(formData.totalCost) : null,
          mileageAtService: parseInt(formData.mileageAtService)
        })
      });

      if (response.ok) {
        onSuccess();
      } else {
        alert('Error saving service record');
      }
    } catch (error) {
      console.error('Error:', error);
      alert('Error saving service record');
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <h2 className="text-xl font-bold text-blue-900 mb-6">Add Service Record</h2>
      
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Date & Mileage */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Service Date *</label>
            <input
              type="date"
              value={formData.serviceDate}
              onChange={(e) => setFormData({...formData, serviceDate: e.target.value})}
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:outline-none transition-colors"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Mileage *</label>
            <input
              type="number"
              value={formData.mileageAtService}
              onChange={(e) => setFormData({...formData, mileageAtService: e.target.value})}
              placeholder="Current mileage"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:outline-none transition-colors"
              required
            />
          </div>
        </div>

        {/* Service Type & Cost */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Service Type *</label>
            <select
              value={formData.serviceType}
              onChange={(e) => setFormData({...formData, serviceType: e.target.value})}
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:outline-none transition-colors"
              required
            >
              {serviceTypes.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Total Cost (£)</label>
            <input
              type="number"
              step="0.01"
              value={formData.totalCost}
              onChange={(e) => setFormData({...formData, totalCost: e.target.value})}
              placeholder="0.00"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:outline-none transition-colors"
            />
          </div>
        </div>

        {/* Garage Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Garage Name</label>
            <input
              type="text"
              value={formData.garageName}
              onChange={(e) => setFormData({...formData, garageName: e.target.value})}
              placeholder="e.g., Kwik Fit Manchester"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:outline-none transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Phone</label>
            <input
              type="tel"
              value={formData.garagePhone}
              onChange={(e) => setFormData({...formData, garagePhone: e.target.value})}
              placeholder="0161 XXX XXXX"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:outline-none transition-colors"
            />
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">Work Done</label>
          <textarea
            value={formData.description}
            onChange={(e) => setFormData({...formData, description: e.target.value})}
            placeholder="e.g., Oil change, air filter replacement, brake pads..."
            className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:outline-none transition-colors"
            rows="3"
          />
        </div>

        {/* Receipt Upload */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">Upload Receipt</label>
          <div className="flex gap-3">
            <input
              type="file"
              accept="image/*,.pdf"
              onChange={handleFileChange}
              className="flex-1 px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:outline-none transition-colors"
            />
            {receiptFile && (
              <button
                type="button"
                onClick={processReceiptOCR}
                disabled={ocrProcessing}
                className="bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
              >
                {ocrProcessing ? 'Scanning...' : '🔍 Scan Receipt'}
              </button>
            )}
          </div>
          {receiptPreview && (
            <img src={receiptPreview} alt="Receipt preview" className="mt-3 max-w-xs rounded-lg border" />
          )}
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">Additional Notes</label>
          <textarea
            value={formData.notes}
            onChange={(e) => setFormData({...formData, notes: e.target.value})}
            placeholder="Any additional information..."
            className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:outline-none transition-colors"
            rows="2"
          />
        </div>

        {/* Buttons */}
        <div className="flex flex-col md:flex-row gap-3 pt-4">
          <button
            type="submit"
            disabled={processing}
            className="flex-1 bg-orange-500 text-white py-3 rounded-lg font-semibold hover:bg-orange-600 disabled:bg-gray-300 transition-colors"
          >
            {processing ? 'Saving...' : '✓ Save Service Record'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-8 py-3 border-2 border-gray-300 rounded-lg font-semibold hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ===== SERVICE TIMELINE COMPONENT =====
function ServiceTimeline({ services, loading, vehicle }) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
        <div className="animate-spin w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full mx-auto"></div>
        <p className="mt-4 text-gray-600">Loading service history...</p>
      </div>
    );
  }

  if (services.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
        <div className="text-gray-400 mb-4">
          <svg className="w-20 h-20 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h3 className="text-2xl font-semibold text-gray-700 mb-2">No Service Records Yet</h3>
        <p className="text-gray-500">Start tracking your vehicle's maintenance history today</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <h2 className="text-xl font-bold text-blue-900 mb-6">Service Timeline</h2>
      
      <div className="space-y-6">
        {services.map((service, index) => (
          <div key={service.id} className="relative pl-10 pb-6 border-l-2 border-blue-200 last:border-0">
            {/* Timeline Dot */}
            <div className="absolute left-[-10px] top-0 w-5 h-5 bg-blue-500 rounded-full border-4 border-white shadow-md"></div>
            
            {/* Service Card */}
            <div className="bg-gradient-to-br from-gray-50 to-white rounded-xl p-5 hover:shadow-lg transition-all duration-200 border border-gray-100">
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-lg font-bold text-blue-900 mb-1">{service.serviceType}</h3>
                  <p className="text-sm text-gray-600">
                    {new Date(service.serviceDate).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric'
                    })}
                  </p>
                </div>
                {service.totalCost && (
                  <div className="bg-green-100 px-4 py-2 rounded-lg text-right">
                    <div className="text-2xl font-bold text-green-700">£{service.totalCost.toFixed(2)}</div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-gray-500">📍 Mileage:</span>
                  <span className="font-semibold">{service.mileageAtService.toLocaleString()} miles</span>
                </div>
                {service.garageName && (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500">🔧 Garage:</span>
                    <span className="font-semibold">{service.garageName}</span>
                  </div>
                )}
              </div>

              {service.description && (
                <div className="bg-white p-4 rounded-lg border border-gray-200 text-sm mb-4">
                  <strong className="text-blue-900">Work Done:</strong>
                  <p className="text-gray-700 mt-1">{service.description}</p>
                </div>
              )}

              {service.notes && (
                <div className="bg-blue-50 p-3 rounded-lg text-sm mb-4">
                  <strong className="text-blue-900">Notes:</strong>
                  <p className="text-gray-700 mt-1">{service.notes}</p>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {service.receiptImageUrl && (
                  <a
                    href={service.receiptImageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                    View Receipt
                  </a>
                )}
                {service.garagePhone && (
                  <a
                    href={`tel:${service.garagePhone}`}
                    className="inline-flex items-center gap-2 text-sm text-green-600 hover:text-green-700 font-medium"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                    Call Garage
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===== EXPORT BUTTON COMPONENT =====
function ExportHistoryButton({ vehicle, services }) {
  const [generating, setGenerating] = useState(false);

  async function generatePDF() {
    setGenerating(true);
    
    try {
      const response = await fetch(`/api/vehicles/${vehicle.id}/export-history`, {
        method: 'POST'
      });
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${vehicle.registrationNumber}-service-history-${new Date().toISOString().split('T')[0]}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      alert('Error generating report. Please try again.');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl shadow-lg p-6 text-white">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold mb-2">Export Service History</h3>
          <p className="text-blue-100 text-sm">
            Generate a professional PDF report of all {services.length} service records
          </p>
        </div>
        <button
          onClick={generatePDF}
          disabled={generating}
          className="bg-white text-blue-700 px-6 py-3 rounded-lg font-semibold hover:bg-blue-50 disabled:bg-gray-300 disabled:text-gray-600 transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          {generating ? 'Generating...' : 'Export PDF'}
        </button>
      </div>
    </div>
  );
}
