package org.erachain.webserver;
// 30/03

import org.erachain.at.AT;
import org.erachain.at.AT_API_Helper;
import org.erachain.at.AT_Transaction;
import com.google.common.collect.Lists;
import org.erachain.core.account.Account;
import org.erachain.core.crypto.Base58;
import org.erachain.core.transaction.R_Send;
import org.erachain.core.transaction.Transaction;
import org.erachain.datachain.DCSet;
import org.bouncycastle.util.encoders.Hex;
import org.erachain.utils.Converter;

import java.math.BigDecimal;
import java.nio.charset.Charset;
import java.util.*;

public class ATWebResource {

    private static ATWebResource instance = new ATWebResource();

    public static ATWebResource getInstance() {
        if (instance == null) {
            instance = new ATWebResource();
        }
        return instance;
    }

    private AT getAT(String id) {
        return DCSet.getInstance().getATMap().get(id);
    }

    public Collection<String> getIdsByType(String type) {
        return DCSet.getInstance().getATMap().getTypeATsList(type);
    }

    public Map<String, Collection<String>> getIdsByTypeAndTags(String type) {
        Map<String, Collection<String>> tagMap = new TreeMap<String, Collection<String>>();
        Collection<String> ats = DCSet.getInstance().getATMap().getTypeATsList(type);
        for (String at : ats) {
            String[] tags = DCSet.getInstance().getATMap().get(at).getTags().split(",");

            for (String tag : tags) {
                if (tagMap.get(tag) != null) {
                    tagMap.get(tag).add(at);
                } else {
                    Collection<String> col = new ArrayList<String>();
                    col.add(at);
                    tagMap.put(tag, col);
                }
            }
        }
        return tagMap;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    public Collection<String> getCol(TreeMap map, String key) {
        return (Collection<String>) map.get(key);
    }

    public String getIncTxCount(String atId) {
        return String.valueOf(DCSet.getInstance().getTransactionFinalMap().getTransactionsByRecipient(atId).size());
    }

    public List<Transaction> getIncomingTransactions(String atId) {
        return DCSet.getInstance().getTransactionFinalMap().getTransactionsByRecipient(atId);
    }

    public List<AT_Transaction> getOutgoingTransactions(String atId) {
        return DCSet.getInstance().getATTransactionMap().getATTransactionsBySender(atId);
    }

    public List<AT_Transaction> getOutgoingTransactions(AT at) {
        return getOutgoingTransactions(Base58.encode(at.getId()));
    }

    public Collection<String> getATsByCreator(String creator) {
        return Lists.newArrayList(DCSet.getInstance().getATMap().getATsByCreator(creator));
    }

    public Collection<String> getOrderedATs(int height) {
        return Lists.newArrayList(DCSet.getInstance().getATMap().getOrderedATs(height));
    }

    public String getAsHex(String atId, String startPos, String endPos) {
        int start = Integer.valueOf(startPos);
        int end = Integer.valueOf(endPos);
        AT at = getAT(atId);
        return Hex.toHexString(Arrays.copyOfRange(at.getAp_data().array(), start, end));
    }

    public String getAsHex(String atId, int startPos, int endPos) {
        AT at = getAT(atId);
        return Hex.toHexString(Arrays.copyOfRange(at.getAp_data().array(), startPos, endPos));
    }

    public String getAsBase58(String atId, String startPos, String endPos) {
        int start = Integer.valueOf(startPos);
        int end = Integer.valueOf(endPos);
        AT at = getAT(atId);

        return Base58.encode(Arrays.copyOfRange(at.getAp_data().array(), start, end));
    }

    public Long getLong(String atId, String startPos) {
        int start = Integer.valueOf(startPos);
        AT at = getAT(atId);

        return AT_API_Helper.getLong(Arrays.copyOfRange(at.getAp_data().array(), start, start + 8));
    }

    public int getInt(String atId, String startPos) {
        int start = Integer.valueOf(startPos);
        AT at = getAT(atId);
        return at.getAp_data().getInt(start);
    }

    public String getDesc(String atId) {
        AT at = getAT(atId);
        return at.getDescription();
    }

    public String getName(String atId) {
        AT at = getAT(atId);
        return at.getName();
    }

    public int getCHeight(String atId) {
        AT at = getAT(atId);
        return at.getCreationBlockHeight();
    }

    public String getCreator(String atId) {
        AT at = getAT(atId);
        return Base58.encode(at.getCreator());
    }

    public String getTags(String atId) {
        AT at = getAT(atId);
        return at.getTags();
    }

    public String getType(String atId) {
        AT at = getAT(atId);
        return at.getType();
    }

    public String getBalance(String atId) {
        AT at = getAT(atId);
        return BigDecimal.valueOf(at.getG_balance()).toPlainString();
    }

    public String getABalance(String atId) {
        Account acc = new Account(atId);
        return acc.getBalanceUSE(Transaction.FEE_KEY).toPlainString();
    }

    public String getMessage(R_Send tx) {
        if (tx instanceof R_Send) {
            R_Send message = tx;
            if ((!message.isEncrypted())) {
                return (message.isText()) ?
                        new String(message.getData(), Charset.forName("UTF-8")) :
                        Converter.toHex(message.getData());
            } else {
                return "encrypted";
            }
        }
        return "";
    }

    public List<Transaction> getMessageTransactions(String address) {
        List<Transaction> txs = DCSet.getInstance().getTransactionFinalMap().getTransactionsByTypeAndAddress(address, Transaction.SEND_ASSET_TRANSACTION, 50);
        return txs;

    }


}