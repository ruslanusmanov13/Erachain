package gui.models;

import controller.Controller;
import core.item.ItemCls;
import core.item.assets.AssetCls;
import core.transaction.*;
import database.wallet.TransactionMap;
import datachain.DCSet;
import datachain.SortableList;
import gui.Gui;
import lang.Lang;
import ntp.NTP;
import org.apache.log4j.Logger;
import org.mapdb.Fun;
import org.mapdb.Fun.Tuple2;
import settings.Settings;
import utils.DateTimeFormat;
import utils.ObserverMessage;
import utils.Pair;
import utils.PlaySound;

import javax.validation.constraints.Null;
import java.math.BigDecimal;
import java.util.Arrays;
import java.util.Observable;
import java.util.Observer;

@SuppressWarnings("serial")
// in list of records in wallet
public class WalletTransactionsTableModel extends TableModelCls<Tuple2<String, String>, Transaction> implements Observer {

    private boolean needUpdate = false;
    private long timeUpdate = 0;

    public static final int COLUMN_CONFIRMATIONS = 0;
    public static final int COLUMN_TIMESTAMP = 1;
    public static final int COLUMN_TYPE = 2;
    public static final int COLUMN_CREATOR = 3;
    public static final int COLUMN_ITEM = 4;
    public static final int COLUMN_AMOUNT = 5;
    public static final int COLUMN_RECIPIENT = 6;
    public static final int COLUMN_FEE = 7;
    public static final int COLUMN_SIZE = 8;
    static Logger LOGGER = Logger.getLogger(WalletTransactionsTableModel.class.getName());
    //ItemAssetMap dbItemAssetMap;
    private SortableList<Tuple2<String, String>, Transaction> transactions;
    private String[] columnNames = Lang.getInstance().translate(new String[]{
            "Confirmations", "Timestamp", "Type", "Creator", "Item", "Amount", "Recipient", "Fee", "Size"});
    private Boolean[] column_AutuHeight = new Boolean[]{true, true, true, true, true, true, true, false, false};

    public WalletTransactionsTableModel() {
        addObservers();

        //dbItemAssetMap = DBSet.getInstance().getItemAssetMap();

    }

    @Override
    public SortableList<Tuple2<String, String>, Transaction> getSortableList() {
        return this.transactions;
    }

    public void setAsset(AssetCls asset) {


    }


    public Object getItem(int row) {
        return this.transactions.get(row).getB();
    }

    public Class<? extends Object> getColumnClass(int c) {     // set column type
        Object o = getValueAt(0, c);
        return o == null ? Null.class : o.getClass();
    }

    // читаем колонки которые изменяем высоту
    public Boolean[] get_Column_AutoHeight() {

        return this.column_AutuHeight;
    }

    // устанавливаем колонки которым изменить высоту
    public void set_get_Column_AutoHeight(Boolean[] arg0) {
        this.column_AutuHeight = arg0;
    }

    public Transaction getTransaction(int row) {
        Pair<Tuple2<String, String>, Transaction> data = this.transactions.get(row);
        if (data == null || data.getB() == null) {
            return null;
        }
        return data.getB();
    }

    @Override
    public int getColumnCount() {
        return columnNames.length;
    }

    @Override
    public String getColumnName(int index) {
        return columnNames[index];
    }

    @Override
    public int getRowCount() {
        if (this.transactions == null) {
            return 0;
        }

        return this.transactions.size();
    }

    @Override
    public Object getValueAt(int row, int column) {
        //try
        //{
        if (this.transactions == null || this.transactions.size() - 1 < row) {
            return null;
        }

        Pair<Tuple2<String, String>, Transaction> data = this.transactions.get(row);

        if (data == null || data.getB() == null) {
            return null;
        }

        Tuple2<String, String> addr1 = data.getA();
        if (addr1 == null)
            return null;

        String creator_address = data.getA().a;
        //Account creator = new Account(data.getA().a);
        //Account recipient = null; // = new Account(data.getA().b);

        Transaction transaction = data.getB();
        if (transaction == null)
            return null;

        transaction.setDC(DCSet.getInstance(), false);

        //creator = transaction.getCreator();
        String itemName = "";
        if (transaction instanceof TransactionAmount && transaction.getAbsKey() > 0) {
            TransactionAmount transAmo = (TransactionAmount) transaction;
            //recipient = transAmo.getRecipient();
            ItemCls item = DCSet.getInstance().getItemAssetMap().get(transAmo.getAbsKey());
            if (item == null)
                return null;

            itemName = item.toString();
        } else if (transaction instanceof GenesisTransferAssetTransaction) {
            GenesisTransferAssetTransaction transGen = (GenesisTransferAssetTransaction) transaction;
            //recipient = transGen.getRecipient();
            ItemCls item = DCSet.getInstance().getItemAssetMap().get(transGen.getAbsKey());
            if (item == null)
                return null;

            itemName = item.toString();
            creator_address = transGen.getRecipient().getAddress();
        } else if (transaction instanceof Issue_ItemRecord) {
            Issue_ItemRecord transIssue = (Issue_ItemRecord) transaction;
            ItemCls item = transIssue.getItem();
            if (item == null)
                return null;

            itemName = item.getShort();
        } else if (transaction instanceof GenesisIssue_ItemRecord) {
            GenesisIssue_ItemRecord transIssue = (GenesisIssue_ItemRecord) transaction;
            ItemCls item = transIssue.getItem();
            if (item == null)
                return null;

            itemName = item.getShort();
        } else if (transaction instanceof R_SertifyPubKeys) {
            R_SertifyPubKeys sertifyPK = (R_SertifyPubKeys) transaction;
            //recipient = transAmo.getRecipient();
            ItemCls item = DCSet.getInstance().getItemPersonMap().get(sertifyPK.getAbsKey());
            if (item == null)
                return null;

            itemName = item.toString();
        } else {

            try {
                if (transaction.viewItemName() != null) {
                    itemName = transaction.viewItemName();
                }
            } catch (Exception e) {
                // TODO Auto-generated catch block
                //e.printStackTrace();
                itemName = "";
            }


        }
        switch (column) {
            case COLUMN_CONFIRMATIONS:

                return transaction.getConfirmations(DCSet.getInstance());

            case COLUMN_TIMESTAMP:


                return DateTimeFormat.timestamptoString(transaction.getTimestamp());//.viewTimestamp(); // + " " + transaction.getTimestamp() / 1000;

            case COLUMN_TYPE:

                return Lang.getInstance().translate(transaction.viewFullTypeName());

            case COLUMN_CREATOR:

                return transaction.viewCreator();

            case COLUMN_ITEM:
                return itemName;

            case COLUMN_AMOUNT:

                BigDecimal amo = transaction.getAmount();
                if (amo == null)
                    return BigDecimal.ZERO;
                return amo;

            case COLUMN_RECIPIENT:

                try {
                    return transaction.viewRecipient();
                } catch (Exception e) {
                    // TODO Auto-generated catch block
                    //e.printStackTrace();
                    return "";
                }

            case COLUMN_FEE:

                return transaction.getFee();

            case COLUMN_SIZE:
                return transaction.viewSize(false);
        }

        return null;

        //} catch (Exception e) {
        //GUI ERROR
        //	LOGGER.error(e.getMessage(),e);
        //	return null;
        //}

    }

    @Override
    public void update(Observable o, Object arg) {
        try {
            this.syncUpdate(o, arg);
        } catch (Exception e) {
            //GUI ERROR
        }
    }

    @SuppressWarnings("unchecked")
    public synchronized void syncUpdate(Observable o, Object arg) {
        ObserverMessage message = (ObserverMessage) arg;

        //CHECK IF NEW LIST
        if (message.getType() == ObserverMessage.WALLET_LIST_TRANSACTION_TYPE) {
            if (this.transactions == null) {
                this.transactions = (SortableList<Tuple2<String, String>, Transaction>) message.getValue();
                this.transactions.registerObserver();
                this.transactions.sort(TransactionMap.TIMESTAMP_INDEX, true);
            }

            this.fireTableDataChanged();

        } else if (message.getType() == ObserverMessage.CHAIN_ADD_BLOCK_TYPE
                    || message.getType() == ObserverMessage.CHAIN_REMOVE_BLOCK_TYPE) {
                // если прилетел блок или откатился и нужно обновить - то обновляем
                if (!needUpdate)
                    return;

                long period = NTP.getTime() - this.timeUpdate;
                if (period < Gui.PERIOD_UPDATE)
                    return;

                this.timeUpdate = NTP.getTime();
                needUpdate = false;
                this.fireTableDataChanged();

            } else if (message.getType() == ObserverMessage.BLOCKCHAIN_SYNC_STATUS
                            || message.getType() == ObserverMessage.WALLET_SYNC_STATUS) {
                if (!needUpdate)
                    return;

                this.timeUpdate = NTP.getTime();
                needUpdate = false;
                this.fireTableDataChanged();

            } else if (message.getType() == ObserverMessage.WALLET_ADD_TRANSACTION_TYPE) {
                // INCOME

                Transaction record = (Transaction) message.getValue();

                Pair<Tuple2<String, String>, Transaction> pair = new Pair<Tuple2<String, String>, Transaction>(
                        new Tuple2<String, String>(record.getCreator().getAddress(), new String(record.getSignature())), record);
                boolean found = this.transactions.contains(pair);

                if (found)
                    return;

                this.transactions.add(pair);

                if (DCSet.getInstance().getTransactionMap().contains(((Transaction) message.getValue()).getSignature())) {
                    if (record.getType() == Transaction.SEND_ASSET_TRANSACTION) {
                        gui.library.library.notifySysTrayRecord(record);
                    } else if (Settings.getInstance().isSoundNewTransactionEnabled()) {
                        PlaySound.getInstance().playSound("newtransaction.wav", record.getSignature());
                    }
                }

            } else if (message.getType() == ObserverMessage.ADD_UNC_TRANSACTION_TYPE) {
                // INCOME

                Transaction record = (Transaction) message.getValue();

                if (!Controller.getInstance().wallet.accountExists(record.getCreator().getAddress())) {
                    return;
                }

                Pair<Tuple2<String, String>, Transaction> pair = new Pair<Tuple2<String, String>, Transaction>(
                        new Tuple2<String, String>(record.getCreator().getAddress(), new String(record.getSignature())), record);
                boolean found = this.transactions.contains(pair);

                if (found)
                    return;

                this.transactions.add(pair);

                if (DCSet.getInstance().getTransactionMap().contains(((Transaction) message.getValue()).getSignature())) {
                    if (record.getType() == Transaction.SEND_ASSET_TRANSACTION) {
                        gui.library.library.notifySysTrayRecord(record);
                    } else if (Settings.getInstance().isSoundNewTransactionEnabled()) {
                        PlaySound.getInstance().playSound("newtransaction.wav", record.getSignature());
                    }
                }

                if (!needUpdate) {
                    needUpdate = true;
                }
                return;

            } else if (message.getType() == ObserverMessage.WALLET_REMOVE_TRANSACTION_TYPE) {

            Transaction record = (Transaction) message.getValue();
            byte[] signKey = record.getSignature();
            for (int i = 0; i < this.transactions.size() - 1; i++) {
                Transaction item = this.transactions.get(i).getB();
                if (item == null)
                    return;
                if (Arrays.equals(signKey, item.getSignature())) {
                    this.transactions.remove(i);
                    //this.fireTableRowsDeleted(i, i); //.fireTableDataChanged();
                    break;
                }
            }

            if (needUpdate) {
                return;
            } else {
                needUpdate = true;
                return;
            }
        }
    }

    public void addObservers() {

        /////Controller.getInstance().addWalletListener(this);
        //REGISTER ON TRANSACTIONS
        Controller.getInstance().getWallet().database.getTransactionMap().addObserver(this);

    }


    public void removeObservers() {

        ////Controller.getInstance().deleteObserver(this);
        Controller.getInstance().getWallet().database.getTransactionMap().deleteObserver(this);
        Controller.getInstance().wallet.database.getPersonMap().deleteObserver(transactions);
    }
}
